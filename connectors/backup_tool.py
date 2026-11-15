"""Agent OS backups: encryption, off-site upload, retention and status.

Runs inside the connectors container, which ships `age` and `rclone`, so the host
needs nothing beyond Docker. Used two ways:

  * scripts/backup.sh collects each component into a stage folder on the host, then
    calls `python backup_tool.py finish <stage>` here to pack, encrypt, upload, prune
    and record the result.
  * app.py imports this module for the dashboard's Backups page.

Encryption uses age with up to two recipients, so either key opens an archive:
  * the recovery kit, generated on this server and handed to the owner once;
  * an optional operator key (public half only ever lives here), so whoever manages
    the install can restore it if the owner loses the kit.
An archive is only uploaded when it is encrypted.
"""
import os
import re
import sys
import json
import time
import shutil
import hashlib
import datetime
import subprocess
import fcntl

CFG = os.environ.get("AOS_BACKUP_CONFIG", "/backup-config")
OUT = os.environ.get("AOS_BACKUP_DIR", "/backups")
REMOTE = "backup"                      # rclone remote name inside rclone.conf
AGE_PUB_RE = re.compile(r"^age1[0-9a-z]{58}$")
# Storage types accepted from a pasted rclone config (cloud services only: nothing
# that wraps another remote, keeps files locally, or shells out).
CUSTOM_TYPES = {"onedrive", "dropbox", "box", "b2", "pcloud", "drive", "s3", "azureblob",
                "googlecloudstorage", "sharefile", "jottacloud", "koofr", "mega", "protondrive"}
CUSTOM_BLOCKED_OPTIONS = {"remote", "upstreams", "ssh", "key_pem", "key_use_agent", "known_hosts_file", "env_auth"}
KINDS = {"gdrive": "Google Drive", "s3": "S3-compatible storage", "custom": "OneDrive or other (rclone config)"}


def _p(name):
    return os.path.join(CFG, name)


def _now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


def load_settings():
    try:
        with open(_p("settings.json"), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_settings(d):
    os.makedirs(CFG, exist_ok=True)
    _write_private(_p("settings.json"), json.dumps(d, indent=1))


# --- keys ---------------------------------------------------------------------

def operator_key(settings=None):
    s = settings if settings is not None else load_settings()
    k = (s.get("operator_public_key") or os.environ.get("OPERATOR_BACKUP_PUBKEY") or "").strip()
    return k if AGE_PUB_RE.match(k) else ""


def recipients(settings=None):
    s = settings if settings is not None else load_settings()
    out = []
    for k in (s.get("kit_public_key") or "", operator_key(s)):
        if AGE_PUB_RE.match(k) and k not in out:
            out.append(k)
    return out


def init_kit(force=False):
    """Create the owner's recovery kit once. The private half is written to a file the
    owner downloads; kit_saved() removes it from the server afterwards."""
    s = load_settings()
    if s.get("kit_public_key") and not force:
        return s["kit_public_key"]
    r = subprocess.run(["age-keygen"], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError("Could not generate a recovery key.")
    pub = ""
    for line in (r.stdout + "\n" + r.stderr).splitlines():
        m = re.search(r"public key:\s*(age1[0-9a-z]{58})", line, re.I)
        if m:
            pub = m.group(1)
    secret = next((ln.strip() for ln in r.stdout.splitlines() if ln.startswith("AGE-SECRET-KEY-")), "")
    if not pub or not secret:
        raise RuntimeError("Could not read the generated recovery key.")
    kit = ("# Agent OS backup recovery kit\n"
           "# Created " + _now().isoformat() + "\n"
           "#\n"
           "# Keep this file somewhere safe that is NOT this server: a password manager,\n"
           "# or printed and locked away. It opens every backup made by this install.\n"
           "# Anyone who has it can read those backups. If it is lost, only the operator\n"
           "# key (if one was set) can restore them.\n"
           "#\n"
           "# To restore: scripts/restore.sh <backup file> <this file>\n"
           "#\n"
           "# public key: " + pub + "\n" + secret + "\n")
    os.makedirs(CFG, exist_ok=True)
    _write_private(_p("recovery-kit.txt"), kit)
    s["kit_public_key"] = pub
    s["kit_created_at"] = _now().isoformat()
    s.pop("kit_saved_at", None)
    save_settings(s)
    return pub


def kit_text():
    try:
        with open(_p("recovery-kit.txt"), "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def kit_saved():
    s = load_settings()
    try:
        os.remove(_p("recovery-kit.txt"))
    except FileNotFoundError:
        pass
    s["kit_saved_at"] = _now().isoformat()
    save_settings(s)


def set_operator_key(key):
    key = (key or "").strip()
    if key and not AGE_PUB_RE.match(key):
        raise ValueError("That is not an age public key (it starts with age1 and is 62 characters).")
    s = load_settings()
    if key:
        s["operator_public_key"] = key
    else:
        s.pop("operator_public_key", None)
    save_settings(s)


# --- remote storage -------------------------------------------------------------

def _rclone(args, timeout=600):
    return subprocess.run(["rclone", "--config", _p("rclone.conf"), "--retries", "2"] + args,
                          capture_output=True, text=True, timeout=timeout)


def _clean_err(text):
    t = re.sub(r"(?i)(token|secret|key|password)\S*\s*[=:]\s*\S+", r"\1=[hidden]", text or "")
    lines = [ln for ln in t.strip().splitlines() if ln.strip()]
    last = re.sub(r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d \w+\s*:\s*", "", lines[-1]) if lines else "unknown error"
    if re.search(r"(?i)invalid_grant|unauthorized|401|token.*(expired|revoked)|couldn't fetch token", t):
        return "the storage refused the sign-in. Make a fresh token and paste it again."
    if re.search(r"(?i)rateLimitExceeded|userRateLimitExceeded|too many requests|\b429\b", t):
        return ("the storage is turning requests away as too frequent (rate limit). It will be tried again "
                "automatically. If this keeps happening with Google Drive, connect it with your own Google "
                "client ID (see the Backups page).")
    return last[:200]


def _one_line(v, what):
    v = str(v or "").strip()
    if not v or "\n" in v or "\r" in v:
        raise ValueError(what + " is missing or not a single line.")
    return v


def remote_configured():
    return os.path.exists(_p("rclone.conf")) and bool(load_settings().get("remote_kind"))


def set_remote(kind, path, fields):
    """Write the storage connection and prove it works before keeping it."""
    if kind not in KINDS:
        raise ValueError("Unknown storage type.")
    path = str(path or "").strip().strip("/")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,200}$", path):
        raise ValueError("Give a folder (or bucket/folder) using letters, numbers, spaces, dots, dashes and slashes.")
    if kind == "gdrive":
        tok = _one_line(fields.get("token"), "The Google Drive token")
        try:
            tj = json.loads(tok)
            assert isinstance(tj, dict) and tj.get("access_token") and tj.get("refresh_token")
        except Exception:
            raise ValueError("That is not the token rclone prints. Paste the whole {...} block, including the braces.")
        conf = "[%s]\ntype = drive\ntoken = %s\n" % (REMOTE, json.dumps(tj, separators=(",", ":")))
        # Optional: your own Google client, which gets its own request allowance instead
        # of sharing rclone's. The token must have been made with the same client.
        cid, csec = str(fields.get("client_id") or "").strip(), str(fields.get("client_secret") or "").strip()
        if cid or csec:
            conf += "client_id = %s\nclient_secret = %s\n" % (_one_line(cid, "The client ID"), _one_line(csec, "The client secret"))
    elif kind == "s3":
        conf = ("[%s]\ntype = s3\nprovider = Other\naccess_key_id = %s\nsecret_access_key = %s\nendpoint = %s\n"
                % (REMOTE, _one_line(fields.get("access_key_id"), "The access key ID"),
                   _one_line(fields.get("secret_access_key"), "The secret access key"),
                   _one_line(fields.get("endpoint"), "The endpoint URL")))
        if str(fields.get("region") or "").strip():
            conf += "region = %s\n" % _one_line(fields.get("region"), "The region")
    else:
        raw = str(fields.get("config") or "").strip()
        body = [ln for ln in raw.splitlines() if ln.strip() and not ln.strip().startswith("[")]
        if not any(re.match(r"^\s*type\s*=", ln) for ln in body):
            raise ValueError("Paste one section from an rclone config file (it must contain a 'type = ...' line).")
        # A pasted config is powerful: some rclone options run a program or read
        # local files, and wrapper types can point back at this server. So only plain
        # cloud-storage types are accepted, and only ordinary name = value options.
        opts = {}
        for ln in body:
            m = re.match(r"^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$", ln)
            if not m:
                raise ValueError("Each line must look like 'name = value'.")
            opts[m.group(1)] = m.group(2)
        if opts.get("type") not in CUSTOM_TYPES:
            raise ValueError("That storage type is not supported here. Supported: " + ", ".join(sorted(CUSTOM_TYPES)) + ".")
        for name in opts:
            if "command" in name or name in CUSTOM_BLOCKED_OPTIONS or name.endswith("_file"):
                raise ValueError("The option '%s' is not allowed here." % name)
        conf = "[%s]\n%s\n" % (REMOTE, "\n".join("%s = %s" % kv for kv in opts.items()))
    os.makedirs(CFG, exist_ok=True)
    old = None
    try:
        with open(_p("rclone.conf"), "r", encoding="utf-8") as f:
            old = f.read()
    except Exception:
        pass
    _write_private(_p("rclone.conf"), conf)
    probe = ".agent-os-connection-test"
    target = "%s:%s" % (REMOTE, path)
    r = _rclone(["mkdir", target], timeout=90)
    if r.returncode == 0:
        r = subprocess.run(["rclone", "--config", _p("rclone.conf"), "rcat", target + "/" + probe],
                           input="ok\n", capture_output=True, text=True, timeout=90)
    if r.returncode == 0:
        r = _rclone(["deletefile", target + "/" + probe], timeout=90)
    if r.returncode != 0:
        if old is None:
            os.remove(_p("rclone.conf"))
        else:
            _write_private(_p("rclone.conf"), old)
        raise ValueError("Could not write to that storage: " + _clean_err(r.stderr))
    s = load_settings()
    s.update({"remote_kind": kind, "remote_path": path, "remote_set_at": _now().isoformat()})
    save_settings(s)


def clear_remote():
    try:
        os.remove(_p("rclone.conf"))
    except FileNotFoundError:
        pass
    s = load_settings()
    for k in ("remote_kind", "remote_path", "remote_set_at"):
        s.pop(k, None)
    save_settings(s)


# --- pack, upload, prune, status ---------------------------------------------------

def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(stage, version=""):
    comps = []
    for name in sorted(os.listdir(stage)):
        full = os.path.join(stage, name)
        if name == "manifest.json" or not os.path.isfile(full):
            continue
        size = os.path.getsize(full)
        comps.append({"file": name, "bytes": size, "sha256": _sha256(full) if size else None, "ok": size > 0})
    man = {"format": 1, "created_at": _now().isoformat(), "agent_os_version": version, "components": comps}
    with open(os.path.join(stage, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, indent=1)
    return man


def pack(stage):
    """tar.gz the stage folder and encrypt it to every recipient. Returns (path, encrypted)."""
    os.makedirs(OUT, exist_ok=True)
    stamp = _now().strftime("%Y-%m-%d-%H%M")
    rec = recipients()
    base = os.path.join(OUT, "agent-os-" + stamp + ".tar.gz")
    out = base + (".age" if rec else "")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as dst:
        tar = subprocess.Popen(["tar", "-C", stage, "-czf", "-", "."], stdout=subprocess.PIPE)
        if rec:
            cmd = ["age"]
            for k in rec:
                cmd += ["-r", k]
            enc = subprocess.Popen(cmd, stdin=tar.stdout, stdout=dst)
            tar.stdout.close()
            rc = enc.wait() or tar.wait()
        else:
            shutil.copyfileobj(tar.stdout, dst)
            rc = tar.wait()
    if rc != 0 or os.path.getsize(out) == 0:
        try:
            os.remove(out)
        except Exception:
            pass
        raise RuntimeError("Could not build the backup archive.")
    return out, bool(rec)


UPLOAD_LIMIT_SECONDS = 45 * 60     # one attempt may take this long, then it is stopped


class _UploadBusy(Exception):
    pass


def _upload_lock():
    """Only one upload at a time, across the nightly run, retries and 'Back up now'.
    Returns an open file holding the lock, or raises _UploadBusy."""
    f = open(os.path.join(OUT, ".upload.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        raise _UploadBusy()
    return f


def upload(path):
    s = load_settings()
    target = "%s:%s" % (REMOTE, s.get("remote_path") or "")
    lock = _upload_lock()
    try:
        # Paced, because shared sign-in apps (rclone's own Google one) are rate limited,
        # and bounded: an attempt that is getting nowhere is stopped and tried again
        # later instead of holding everything up for hours.
        try:
            r = _rclone(["copyto", path, target + "/" + os.path.basename(path), "--retries", "3", "--retries-sleep", "20s",
                         "--low-level-retries", "10", "--tpslimit", "3", "--drive-chunk-size", "16M",
                         "--timeout", "2m", "--contimeout", "30s", "--max-duration", "40m"], timeout=UPLOAD_LIMIT_SECONDS)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Upload stopped after %d minutes without finishing. It will be tried again later. If this keeps "
                               "happening with Google Drive, connect it with your own Google client ID (see the Backups page)."
                               % (UPLOAD_LIMIT_SECONDS // 60))
        if r.returncode != 0:
            raise RuntimeError("Upload failed: " + _clean_err(r.stderr))
        chk = _rclone(["lsjson", target + "/" + os.path.basename(path)], timeout=120)
        try:
            size = json.loads(chk.stdout)[0].get("Size")
        except Exception:
            size = None
        if size != os.path.getsize(path):
            raise RuntimeError("The uploaded copy is not the same size as the local file. It will be tried again later.")
        keep = int(s.get("keep_remote_days") or 30)
        try:
            _rclone(["delete", target, "--min-age", "%dd" % keep, "--include", "agent-os-*.tar.gz.age"], timeout=300)
        except subprocess.TimeoutExpired:
            pass
        return target
    finally:
        lock.close()


def _write_status(st):
    tmp = os.path.join(OUT, "status.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, os.path.join(OUT, "status.json"))


def retry_upload(min_gap_seconds=1800):
    """Send the newest backup again if its upload failed. Called every few minutes by
    scripts/backup.sh, so it spaces its own attempts (30 minutes, then longer each
    time). Returns None when there is nothing to do."""
    st = read_status()
    if not st or not st.get("ok") or st.get("uploaded") or not st.get("encrypted") or not remote_configured():
        return None
    path = os.path.join(OUT, st.get("file") or "")
    tries = int(st.get("upload_tries") or 0)
    if not os.path.isfile(path) or (tries >= 8 and min_gap_seconds):   # asked for by hand: always try
        return None
    gap = min(min_gap_seconds * (2 ** max(0, tries - 1)), 6 * 3600) if tries else 0
    if time.time() - float(st.get("upload_tried_at") or 0) < gap:
        return None
    try:
        probe = _upload_lock()   # another upload is in progress: leave it to finish
        probe.close()
    except _UploadBusy:
        return None
    # Record the attempt BEFORE starting, so a slow one is never started twice.
    st["upload_tries"] = tries + 1
    st["upload_tried_at"] = time.time()
    _write_status(st)
    try:
        st["remote"] = upload(path)
        st["uploaded"] = True
        st["upload_error"] = None
    except _UploadBusy:
        return None
    except Exception as e:
        st["upload_error"] = str(e)[:400]
    _write_status(st)
    return st


def prune_local():
    keep = int(load_settings().get("keep_local_days") or 14)
    cutoff = time.time() - keep * 86400
    for name in os.listdir(OUT):
        full = os.path.join(OUT, name)
        if re.match(r"^(agent-os-.*\.tar\.gz(\.age)?|honcho-.*\.sql\.gz)$", name) and os.path.getmtime(full) < cutoff:
            try:
                os.remove(full)
            except Exception:
                pass


def read_status():
    try:
        with open(os.path.join(OUT, "status.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def finish(stage, version="", failed=None):
    """Called by scripts/backup.sh once the components are in `stage`."""
    st = {"at": _now().isoformat(), "ok": False, "file": None, "bytes": None, "encrypted": False,
          "uploaded": False, "remote": None, "components": [], "missing": list(failed or []), "error": None,
          "upload_error": None, "agent_os_version": version}
    try:
        man = write_manifest(stage, version)
        st["components"] = [{"file": c["file"], "bytes": c["bytes"], "ok": c["ok"]} for c in man["components"]]
        st["missing"] = sorted(set(st["missing"]) | {c["file"] for c in man["components"] if not c["ok"]})
        path, encrypted = pack(stage)
        st.update({"file": os.path.basename(path), "bytes": os.path.getsize(path), "encrypted": encrypted, "ok": True})
        if remote_configured():
            if not encrypted:
                st["upload_error"] = "Not uploaded: backups are only sent off this server once encryption is set up."
            elif os.environ.get("AOS_BACKUP_DEFER_UPLOAD"):
                # Made just before an update: do not hold the update up. The regular
                # 5-minute check sends it.
                st["upload_tries"] = 0
                st["upload_tried_at"] = 0
                st["upload_error"] = "Waiting to be copied to your cloud storage (within a few minutes)."
            else:
                st["upload_tries"] = 1
                st["upload_tried_at"] = time.time()
                try:
                    st["remote"] = upload(path)
                    st["uploaded"] = True
                except _UploadBusy:
                    st["upload_tries"] = 0
                    st["upload_tried_at"] = 0
                    st["upload_error"] = "Waiting for an earlier upload to finish; this one is sent afterwards."
                except Exception as e:
                    st["upload_error"] = str(e)[:400]
        prune_local()
    except Exception as e:
        st["error"] = str(e)[:300]
    _write_status(st)
    return st


def summary():
    """What the dashboard shows. Never includes a key, token or the kit's private half."""
    s = load_settings()
    op = operator_key(s)
    files = []
    try:
        for name in sorted(os.listdir(OUT), reverse=True):
            if re.match(r"^agent-os-.*\.tar\.gz(\.age)?$", name):
                full = os.path.join(OUT, name)
                files.append({"name": name, "bytes": os.path.getsize(full), "encrypted": name.endswith(".age")})
    except Exception:
        pass
    return {"status": read_status(),
            "encryption": {"kit_created": bool(s.get("kit_public_key")), "kit_waiting_download": kit_text() is not None,
                           "kit_saved_at": s.get("kit_saved_at"), "operator_key": bool(op),
                           "operator_key_tail": op[-6:] if op else None, "recipients": len(recipients(s))},
            "remote": {"configured": remote_configured(), "kind": s.get("remote_kind"),
                       "kind_label": KINDS.get(s.get("remote_kind") or ""), "path": s.get("remote_path")},
            "keep_local_days": int(s.get("keep_local_days") or 14), "keep_remote_days": int(s.get("keep_remote_days") or 30),
            "files": files[:10], "run_requested": os.path.exists(_p("run-now")), "kinds": KINDS}


def main(argv):
    if len(argv) >= 2 and argv[0] == "finish":
        failed = [x for x in (argv[3].split(",") if len(argv) > 3 else []) if x]
        st = finish(argv[1], argv[2] if len(argv) > 2 else "", failed)
        where = (" and uploaded to " + st["remote"]) if st["uploaded"] else ""
        if st["ok"]:
            print("backup: %s (%.1f MB, %s)%s" % (st["file"], (st["bytes"] or 0) / 1e6,
                                                   "encrypted" if st["encrypted"] else "NOT encrypted", where))
            if st["missing"]:
                print("backup: missing or empty parts: " + ", ".join(st["missing"]))
            if st["upload_error"]:
                print("backup: " + st["upload_error"])
        else:
            print("backup: FAILED: " + str(st["error"]))
        return 0 if st["ok"] else 1
    if argv[:1] == ["retry-upload"]:
        st = retry_upload(0 if "--now" in argv else 1800)
        if st:
            print("backup: " + ("uploaded " + st["file"] + " to " + st["remote"] if st["uploaded"] else st["upload_error"]))
        elif "--now" in argv:
            print("backup: nothing to send right now (already uploaded, no storage connected, or an upload is in progress)")
        return 0
    if argv[:1] == ["init"]:
        init_kit()
        print("recovery kit ready" if kit_text() else "recovery kit already saved")
        return 0
    if argv[:1] == ["operator-key"]:
        try:
            set_operator_key(argv[1] if len(argv) > 1 else "")
        except ValueError as e:
            print(str(e)); return 1
        print("operator key saved" if operator_key() else "operator key removed")
        return 0
    if argv[:1] == ["remote"] and len(argv) >= 3:
        # Secrets arrive on stdin as name=value lines, never as arguments (which show in `ps`).
        if not recipients():
            init_kit()
        try:
            fields = dict(ln.split("=", 1) for ln in sys.stdin.read().splitlines() if "=" in ln)
            set_remote(argv[1], argv[2], fields)
        except (ValueError, subprocess.TimeoutExpired) as e:
            print(str(e) or "That storage did not answer in time."); return 1
        print("connected: backups will be copied to " + KINDS[argv[1]] + ", folder " + argv[2])
        return 0
    print("usage: backup_tool.py finish <stage> [version] [failed,parts] | init | operator-key [age1...] | remote <kind> <folder> (name=value lines on stdin)")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
