"""Business apps the owner connects once on the Connections page.

Each app is plain data: the fields the owner fills in, how a request is signed, one call
that proves the login works, and a short list of named actions agents can run. Actions
marked write change something in the app; the owner can limit an app to read-only.
Nothing here sends money, emails customers or publishes: writes are kept to things that
stay inside the business (a task, a note, a draft, an internal comment).

The same login is also saved in n8n (credential type and field names below) so workflows
can use it without the owner entering it twice.
"""
import base64
import json
import re
import ssl
import time

import httpx

TIMEOUT = 25.0
MAX_OUT = 30000


def _bearer(tok):
    return {"Authorization": "Bearer " + tok}


def _basic(user, pw):
    return {"Authorization": "Basic " + base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()}


def _host(v, suffix=""):
    """A sub-domain the owner typed as 'acme', 'acme.zendesk.com' or 'https://acme.zendesk.com/'."""
    v = re.sub(r"^https?://", "", (v or "").strip()).split("/")[0]
    if suffix and v.endswith(suffix):
        v = v[: -len(suffix)]
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}$", v):
        raise ValueError("That does not look like a %s name." % (suffix.strip(".") or "site"))
    return v


def _site(v):
    """A full https address of the owner's own website, e.g. https://shop.example.com"""
    v = (v or "").strip().rstrip("/")
    if not re.match(r"^https://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$", v):
        raise ValueError("Give the full site address starting with https://")
    return v


def _txt_adf(text):
    """Jira wants rich text as a document; turn plain text into one paragraph per line."""
    return {"type": "doc", "version": 1, "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": line}]} if line else {"type": "paragraph"}
        for line in str(text or "").split("\n")]}


# action: (method, path, description, params, write)
#   params: {name: "description"} - names in {braces} in the path fill the path; for GET the
#   rest become the query; for other methods the rest become the JSON body. A name ending in
#   "?" is optional. "body" as a param name takes a whole JSON object as the body.
#   approval=True: the action can interrupt the business (a restart, a firmware update), so it
#   never runs on an agent's say-so. The agent proposes it, the owner approves the exact
#   action on a card, and only then does Agent OS run it and check the result.
def A(method, path, desc, params=None, write=False, wrap=None, fixed=None, approval=False):
    return {"method": method, "path": path, "desc": desc, "params": params or {}, "write": write or approval,
            "wrap": wrap, "fixed": fixed or {}, "approval": approval}


def _unifi_prepare(f):
    """Find where this controller serves its API and remember its certificate.

    A UniFi console serves the API under /proxy/network; the self-hosted Network Server
    serves it at the top. Most controllers use a self-signed certificate, so the one seen
    now is stored and is the only one accepted from then on."""
    site = _site(f["site"])
    host = re.sub(r"^https://", "", site).split("/")[0]
    name, _, port = host.partition(":")
    out = dict(f, site=site, cert="")
    try:
        with httpx.Client(timeout=10) as c:
            c.get(site)
    except httpx.ConnectError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e) and "certificate" not in str(e).lower():
            raise RuntimeError("Could not reach %s from the Agent OS box. Check the address and port, and that "
                               "this box can reach it on the network." % site)
        out["cert"] = ssl.get_server_certificate((name, int(port or 443)), timeout=10)
    except httpx.HTTPError:
        raise RuntimeError("Could not reach %s from the Agent OS box. Check the address and port, and that this "
                           "box can reach it on the network." % site)
    last = None
    for prefix in ("/proxy/network/integration", "/integration"):
        out["prefix"] = prefix
        try:
            j = _send("unifi", out, "GET", "/v1/info")
            if isinstance(j, dict) and j.get("applicationVersion"):
                return out
        except Exception as e:
            last = e
    raise RuntimeError("The controller did not accept the API key (%s). It needs UniFi Network 9 or newer, with a "
                       "key made under Settings > Control Plane > Integrations." % str(last)[:160])


def _unifi_verify(f):
    if not f.get("cert"):
        return True
    ctx = ssl.create_default_context(cadata=f["cert"])
    ctx.check_hostname = False          # the pinned certificate itself is what is trusted
    return ctx


CATALOG = {
    "notion": {
        "label": "Notion", "category": "Docs & knowledge",
        "about": "Pages, wikis and databases.",
        "fields": [{"key": "token", "label": "Integration secret", "secret": True, "placeholder": "ntn_..."}],
        "steps": ["In Notion open Settings > Connections > Develop or manage integrations (notion.so/profile/integrations).",
                  "Create a new Internal integration named Agent OS in your workspace and copy its secret.",
                  "On each page or database the agents may use, choose ... > Connections > Agent OS. Child pages are included."],
        "base": lambda f: "https://api.notion.com/v1",
        "headers": lambda f: dict(_bearer(f["token"]), **{"Notion-Version": "2022-06-28"}),
        "test": ("GET", "/users/me", lambda j: (j.get("bot") or {}).get("workspace_name") or j.get("name")),
        "n8n": ("notionApi", lambda f: {"apiKey": f["token"]}),
        "actions": {
            "search": A("POST", "/search", "Find pages and databases shared with Agent OS by title.",
                        {"query": "Words to look for", "page_size?": "Up to 100"}),
            "get_page": A("GET", "/pages/{page_id}", "A page's properties.", {"page_id": "Page id"}),
            "get_content": A("GET", "/blocks/{block_id}/children", "The text blocks inside a page (pass the page id).",
                             {"block_id": "Page or block id", "page_size?": "Up to 100", "start_cursor?": "For the next page"}),
            "query_database": A("POST", "/databases/{database_id}/query", "Rows of a database, optionally filtered.",
                                {"database_id": "Database id", "filter?": "Notion filter object", "sorts?": "Notion sorts list",
                                 "page_size?": "Up to 100"}),
            "create_page": A("POST", "/pages", "Create a page under a page or a row in a database.",
                             {"parent": "{\"page_id\": ...} or {\"database_id\": ...}", "properties": "Notion properties (title etc.)",
                              "children?": "Notion blocks for the body"}, write=True),
            "append_content": A("PATCH", "/blocks/{block_id}/children", "Add blocks to the end of a page.",
                                {"block_id": "Page id", "children": "Notion blocks"}, write=True),
            "update_page": A("PATCH", "/pages/{page_id}", "Change a page's or row's properties.",
                             {"page_id": "Page id", "properties": "Notion properties to set"}, write=True),
        },
    },
    "slack": {
        "label": "Slack", "category": "Team chat",
        "about": "Read channels and post messages to your own workspace.",
        "fields": [{"key": "token", "label": "Bot token", "secret": True, "placeholder": "xoxb-..."}],
        "steps": ["Go to api.slack.com/apps, Create New App > From scratch, pick your workspace.",
                  "Under OAuth & Permissions add bot scopes: channels:read, channels:history, chat:write (and groups:read, groups:history for private channels).",
                  "Install to Workspace and copy the Bot User OAuth Token (xoxb-...). Invite the bot to each channel it should use (/invite @AppName)."],
        "base": lambda f: "https://slack.com/api",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/auth.test", lambda j: "%s (%s)" % (j.get("team"), j.get("user")) if j.get("ok") else None),
        "ok_field": "ok",
        "n8n": ("slackApi", lambda f: {"accessToken": f["token"]}),
        "actions": {
            "list_channels": A("GET", "/conversations.list", "Channels the bot can see.",
                               {"types?": "public_channel,private_channel", "limit?": "Up to 200", "cursor?": "Next page"}),
            "read_channel": A("GET", "/conversations.history", "Recent messages in a channel.",
                              {"channel": "Channel id", "limit?": "Up to 200", "oldest?": "Unix time"}),
            "post_message": A("POST", "/chat.postMessage", "Post a message in a channel of your own workspace.",
                              {"channel": "Channel id or #name", "text": "The message", "thread_ts?": "Reply in this thread"}, write=True),
        },
    },
    "github": {
        "label": "GitHub", "category": "Developer",
        "about": "Repositories, issues and files.",
        "fields": [{"key": "token", "label": "Personal access token", "secret": True, "placeholder": "github_pat_..."}],
        "steps": ["GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.",
                  "Pick the repositories, and give Contents: Read, Issues: Read and write, Metadata: Read.",
                  "Copy the token."],
        "base": lambda f: "https://api.github.com",
        "headers": lambda f: dict(_bearer(f["token"]), **{"Accept": "application/vnd.github+json",
                                                          "X-GitHub-Api-Version": "2022-11-28"}),
        "test": ("GET", "/user", lambda j: j.get("login")),
        "n8n": ("githubApi", lambda f: {"accessToken": f["token"], "server": "https://api.github.com"}),
        "actions": {
            "list_repos": A("GET", "/user/repos", "Repositories the token can see.", {"per_page?": "Up to 100", "page?": "Page"}),
            "list_issues": A("GET", "/repos/{owner}/{repo}/issues", "Open issues in a repository.",
                             {"owner": "Owner", "repo": "Repository", "state?": "open, closed or all", "per_page?": "Up to 100"}),
            "get_file": A("GET", "/repos/{owner}/{repo}/contents/{path}", "A file or folder in a repository.",
                          {"owner": "Owner", "repo": "Repository", "path": "File path", "ref?": "Branch"}),
            "create_issue": A("POST", "/repos/{owner}/{repo}/issues", "Open an issue.",
                              {"owner": "Owner", "repo": "Repository", "title": "Title", "body?": "Text"}, write=True),
            "comment_issue": A("POST", "/repos/{owner}/{repo}/issues/{number}/comments", "Comment on an issue or pull request.",
                               {"owner": "Owner", "repo": "Repository", "number": "Issue number", "body": "Text"}, write=True),
        },
    },
    "airtable": {
        "label": "Airtable", "category": "Databases & sheets",
        "about": "Bases, tables and records.",
        "fields": [{"key": "token", "label": "Personal access token", "secret": True, "placeholder": "pat..."}],
        "steps": ["airtable.com/create/tokens > Create token.",
                  "Scopes: data.records:read, data.records:write, schema.bases:read. Add the bases it may use.",
                  "Copy the token."],
        "base": lambda f: "https://api.airtable.com/v0",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/meta/whoami", lambda j: j.get("email") or j.get("id")),
        "n8n": ("airtableTokenApi", lambda f: {"accessToken": f["token"]}),
        "actions": {
            "list_bases": A("GET", "/meta/bases", "Bases the token can use."),
            "list_tables": A("GET", "/meta/bases/{base_id}/tables", "Tables and fields in a base.", {"base_id": "Base id (app...)"}),
            "list_records": A("GET", "/{base_id}/{table}", "Records in a table.",
                              {"base_id": "Base id", "table": "Table name or id", "maxRecords?": "Limit",
                               "filterByFormula?": "Airtable formula", "view?": "View name"}),
            "create_records": A("POST", "/{base_id}/{table}", "Add up to 10 records.",
                                {"base_id": "Base id", "table": "Table", "records": "[{\"fields\": {...}}]"}, write=True),
            "update_records": A("PATCH", "/{base_id}/{table}", "Change up to 10 records.",
                                {"base_id": "Base id", "table": "Table", "records": "[{\"id\": ..., \"fields\": {...}}]"}, write=True),
        },
    },
    "hubspot": {
        "label": "HubSpot", "category": "CRM & sales",
        "about": "Contacts, companies, deals and notes.",
        "fields": [{"key": "token", "label": "Private app access token", "secret": True, "placeholder": "pat-na1-..."}],
        "steps": ["HubSpot > Settings > Integrations > Private Apps > Create a private app.",
                  "Scopes: crm.objects.contacts read and write, crm.objects.companies read, crm.objects.deals read.",
                  "Create the app and copy its access token."],
        "base": lambda f: "https://api.hubapi.com",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/crm/v3/objects/contacts?limit=1", lambda j: "HubSpot account" if "results" in j else None),
        "n8n": ("hubspotAppToken", lambda f: {"appToken": f["token"]}),
        "actions": {
            "search_contacts": A("POST", "/crm/v3/objects/contacts/search", "Find contacts by name, email or company.",
                                 {"query": "Words to look for", "limit?": "Up to 100"}),
            "search_companies": A("POST", "/crm/v3/objects/companies/search", "Find companies.",
                                  {"query": "Words to look for", "limit?": "Up to 100"}),
            "list_deals": A("GET", "/crm/v3/objects/deals", "Deals with stage and amount.",
                            {"limit?": "Up to 100", "properties?": "dealname,amount,dealstage,closedate"}),
            "create_contact": A("POST", "/crm/v3/objects/contacts", "Add a contact.",
                                {"properties": "{\"email\": ..., \"firstname\": ..., \"lastname\": ...}"}, write=True),
            "add_note": A("POST", "/crm/v3/objects/notes", "Add a note (optionally attached to a record).",
                          {"properties": "{\"hs_note_body\": ..., \"hs_timestamp\": ISO time}", "associations?": "HubSpot associations"},
                          write=True),
        },
    },
    "stripe": {
        "label": "Stripe", "category": "Payments & finance",
        "about": "Balance, payments, invoices and customers. Read only.",
        "fields": [{"key": "token", "label": "Restricted key (read only)", "secret": True, "placeholder": "rk_live_..."}],
        "steps": ["Stripe Dashboard > Developers > API keys > Create restricted key.",
                  "Set Read for Balance, Charges, Customers, Invoices and Payouts; leave everything else None.",
                  "Copy the key (rk_live_...). Do not use the secret key (sk_...)."],
        "base": lambda f: "https://api.stripe.com/v1",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/balance", lambda j: "Stripe (%s)" % ("live" if j.get("livemode") else "test") if "available" in j else None),
        "n8n": ("stripeApi", lambda f: {"secretKey": f["token"]}),
        "read_only": True,
        "actions": {
            "balance": A("GET", "/balance", "Available and pending balance."),
            "list_charges": A("GET", "/charges", "Recent payments.", {"limit?": "Up to 100", "customer?": "Customer id"}),
            "list_invoices": A("GET", "/invoices", "Invoices.", {"limit?": "Up to 100", "status?": "draft, open, paid...",
                                                             "customer?": "Customer id"}),
            "list_customers": A("GET", "/customers", "Customers.", {"limit?": "Up to 100", "email?": "Exact email"}),
            "list_payouts": A("GET", "/payouts", "Payouts to the bank.", {"limit?": "Up to 100"}),
        },
    },
    "trello": {
        "label": "Trello", "category": "Projects & tasks",
        "about": "Boards, lists and cards.",
        "fields": [{"key": "key", "label": "API key", "secret": False, "placeholder": "32 characters"},
                   {"key": "token", "label": "Token", "secret": True, "placeholder": "ATTA..."}],
        "steps": ["Go to trello.com/power-ups/admin, create a Power-Up for your workspace and open its API key page.",
                  "Copy the API key, then follow the Token link beside it, allow access and copy the token."],
        "base": lambda f: "https://api.trello.com/1",
        "headers": lambda f: {"Authorization": 'OAuth oauth_consumer_key="%s", oauth_token="%s"' % (f["key"], f["token"])},
        "test": ("GET", "/members/me", lambda j: j.get("username")),
        "n8n": ("trelloApi", lambda f: {"apiKey": f["key"], "apiToken": f["token"]}),
        "actions": {
            "list_boards": A("GET", "/members/me/boards", "Your boards.", {"fields?": "name,url"}),
            "list_lists": A("GET", "/boards/{board_id}/lists", "Lists on a board.", {"board_id": "Board id"}),
            "list_cards": A("GET", "/boards/{board_id}/cards", "Cards on a board.", {"board_id": "Board id"}),
            "create_card": A("POST", "/cards", "Add a card to a list.",
                             {"idList": "List id", "name": "Card title", "desc?": "Description", "due?": "ISO date"}, write=True),
            "comment_card": A("POST", "/cards/{card_id}/actions/comments", "Comment on a card.",
                              {"card_id": "Card id", "text": "Comment"}, write=True),
        },
    },
    "asana": {
        "label": "Asana", "category": "Projects & tasks",
        "about": "Workspaces, projects and tasks.",
        "fields": [{"key": "token", "label": "Personal access token", "secret": True, "placeholder": "2/12345/..."}],
        "steps": ["Asana > profile picture > Settings > Apps > Developer apps (app.asana.com/0/my-apps).",
                  "Create new token, name it Agent OS, and copy it."],
        "base": lambda f: "https://app.asana.com/api/1.0",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/users/me", lambda j: (j.get("data") or {}).get("email")),
        "n8n": ("asanaApi", lambda f: {"accessToken": f["token"]}),
        "actions": {
            "list_workspaces": A("GET", "/workspaces", "Workspaces."),
            "list_projects": A("GET", "/projects", "Projects in a workspace.", {"workspace": "Workspace id"}),
            "list_tasks": A("GET", "/tasks", "Tasks in a project.",
                            {"project": "Project id", "opt_fields?": "name,completed,due_on,assignee.name"}),
            "create_task": A("POST", "/tasks", "Add a task.", {"name": "Title", "notes?": "Details", "projects?": "[project id]",
                                                             "workspace?": "Workspace id", "due_on?": "YYYY-MM-DD"},
                             write=True, wrap="data"),
            "comment_task": A("POST", "/tasks/{task_id}/stories", "Comment on a task.", {"task_id": "Task id", "text": "Comment"},
                              write=True, wrap="data"),
        },
    },
    "clickup": {
        "label": "ClickUp", "category": "Projects & tasks",
        "about": "Spaces, lists and tasks.",
        "fields": [{"key": "token", "label": "Personal API token", "secret": True, "placeholder": "pk_..."}],
        "steps": ["ClickUp > avatar > Settings > Apps.", "Generate the API token and copy it (pk_...)."],
        "base": lambda f: "https://api.clickup.com/api/v2",
        "headers": lambda f: {"Authorization": f["token"]},
        "test": ("GET", "/user", lambda j: (j.get("user") or {}).get("email")),
        "n8n": ("clickUpApi", lambda f: {"accessToken": f["token"]}),
        "actions": {
            "list_workspaces": A("GET", "/team", "Workspaces (ClickUp calls them teams)."),
            "list_spaces": A("GET", "/team/{team_id}/space", "Spaces in a workspace.", {"team_id": "Workspace id"}),
            "list_folderless_lists": A("GET", "/space/{space_id}/list", "Lists in a space.", {"space_id": "Space id"}),
            "list_tasks": A("GET", "/list/{list_id}/task", "Tasks in a list.", {"list_id": "List id", "page?": "Page"}),
            "create_task": A("POST", "/list/{list_id}/task", "Add a task to a list.",
                             {"list_id": "List id", "name": "Title", "description?": "Details", "due_date?": "Unix ms"}, write=True),
        },
    },
    "linear": {
        "label": "Linear", "category": "Projects & tasks",
        "about": "Teams, issues and projects.",
        "fields": [{"key": "token", "label": "Personal API key", "secret": True, "placeholder": "lin_api_..."}],
        "steps": ["Linear > Settings > Account > Security & access > Personal API keys > New key.", "Copy the key."],
        "base": lambda f: "https://api.linear.app",
        "headers": lambda f: {"Authorization": f["token"]},
        "test": ("POST", "/graphql", lambda j: ((j.get("data") or {}).get("viewer") or {}).get("email"),
                 {"query": "{ viewer { email } }"}),
        "n8n": ("linearApi", lambda f: {"apiKey": f["token"]}),
        "graphql": True,
        "actions": {
            "query": A("POST", "/graphql", "Read with a GraphQL query (no mutations), e.g. "
                       "{ issues(first: 20) { nodes { identifier title state { name } } } }",
                       {"query": "GraphQL query", "variables?": "Variables object"}),
            "create_issue": A("POST", "/graphql", "Create an issue in a team.",
                              {"teamId": "Team id", "title": "Title", "description?": "Markdown"}, write=True),
        },
    },
    "jira": {
        "label": "Jira", "category": "Projects & tasks",
        "about": "Projects and issues on Jira Cloud.",
        "fields": [{"key": "site", "label": "Site address", "secret": False, "placeholder": "https://yourcompany.atlassian.net"},
                   {"key": "email", "label": "Your Atlassian email", "secret": False, "placeholder": "you@company.com"},
                   {"key": "token", "label": "API token", "secret": True, "placeholder": "ATATT..."}],
        "steps": ["id.atlassian.com/manage-profile/security/api-tokens > Create API token.",
                  "Copy it, and enter your Jira site address and the email you sign in with."],
        "base": lambda f: _site(f["site"]) + "/rest/api/3",
        "headers": lambda f: _basic(f["email"], f["token"]),
        "test": ("GET", "/myself", lambda j: j.get("emailAddress") or j.get("displayName")),
        "n8n": ("jiraSoftwareCloudApi", lambda f: {"email": f["email"], "apiToken": f["token"], "domain": _site(f["site"])}),
        "actions": {
            "search": A("POST", "/search/jql", "Find issues with JQL, e.g. project = OPS AND status != Done.",
                        {"jql": "JQL", "maxResults?": "Up to 100", "fields?": "[\"summary\",\"status\",\"assignee\"]"}),
            "get_issue": A("GET", "/issue/{key}", "One issue.", {"key": "Issue key, e.g. OPS-12"}),
            "create_issue": A("POST", "/issue", "Create an issue.",
                              {"project": "Project key", "summary": "Title", "description?": "Text",
                               "issuetype?": "Task, Bug or Story (default Task)"}, write=True),
            "comment_issue": A("POST", "/issue/{key}/comment", "Comment on an issue.", {"key": "Issue key", "body": "Text"},
                               write=True),
        },
    },
    "todoist": {
        "label": "Todoist", "category": "Projects & tasks",
        "about": "Projects and to-dos.",
        "fields": [{"key": "token", "label": "API token", "secret": True, "placeholder": "40 characters"}],
        "steps": ["Todoist > Settings > Integrations > Developer.", "Copy the API token."],
        "base": lambda f: "https://api.todoist.com/rest/v2",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/projects", lambda j: "Todoist (%d projects)" % len(j) if isinstance(j, list) else None),
        "n8n": ("todoistApi", lambda f: {"apiKey": f["token"]}),
        "actions": {
            "list_projects": A("GET", "/projects", "Projects."),
            "list_tasks": A("GET", "/tasks", "Open tasks.", {"project_id?": "Project id", "filter?": "Todoist filter, e.g. today"}),
            "create_task": A("POST", "/tasks", "Add a task.", {"content": "Task", "description?": "Details",
                                                             "project_id?": "Project id", "due_string?": "e.g. tomorrow 9am"},
                             write=True),
            "close_task": A("POST", "/tasks/{task_id}/close", "Mark a task done.", {"task_id": "Task id"}, write=True),
        },
    },
    "monday": {
        "label": "monday.com", "category": "Projects & tasks",
        "about": "Boards and items.",
        "fields": [{"key": "token", "label": "API token", "secret": True, "placeholder": "eyJ..."}],
        "steps": ["monday.com > avatar > Developers > My access tokens.", "Copy the token."],
        "base": lambda f: "https://api.monday.com",
        "headers": lambda f: {"Authorization": f["token"], "API-Version": "2024-10"},
        "test": ("POST", "/v2", lambda j: ((j.get("data") or {}).get("me") or {}).get("email"), {"query": "{ me { email } }"}),
        "n8n": ("mondayComApi", lambda f: {"apiToken": f["token"]}),
        "graphql": True,
        "actions": {
            "query": A("POST", "/v2", "Read with a GraphQL query (no mutations), e.g. "
                       "{ boards(limit: 10) { id name items_page(limit: 20) { items { id name } } } }",
                       {"query": "GraphQL query", "variables?": "Variables object"}),
            "create_item": A("POST", "/v2", "Add an item to a board.",
                             {"board_id": "Board id", "item_name": "Name", "group_id?": "Group id"}, write=True),
        },
    },
    "shopify": {
        "label": "Shopify", "category": "E-commerce",
        "about": "Orders, products and customers. Read only.",
        "fields": [{"key": "shop", "label": "Store name", "secret": False, "placeholder": "yourstore (from yourstore.myshopify.com)"},
                   {"key": "token", "label": "Admin API access token", "secret": True, "placeholder": "shpat_..."},
                   {"key": "app_secret", "label": "API secret key (for n8n)", "secret": True, "optional": True,
                    "placeholder": "Optional"}],
        "steps": ["Shopify admin > Settings > Apps and sales channels > Develop apps > Create an app.",
                  "Configure Admin API scopes: read_orders, read_products, read_customers. Install the app.",
                  "Reveal and copy the Admin API access token (shpat_...). The API secret key is only needed for n8n."],
        "base": lambda f: "https://%s.myshopify.com/admin/api/2025-01" % _host(f["shop"], ".myshopify.com"),
        "headers": lambda f: {"X-Shopify-Access-Token": f["token"]},
        "test": ("GET", "/shop.json", lambda j: (j.get("shop") or {}).get("name")),
        "n8n": ("shopifyAccessTokenApi", lambda f: {"shopSubdomain": _host(f["shop"], ".myshopify.com"),
                                                    "accessToken": f["token"], "appSecretKey": f.get("app_secret") or ""}),
        "read_only": True,
        "actions": {
            "list_orders": A("GET", "/orders.json", "Recent orders (pass status any to include closed ones).", {"status?": "any, open or closed", "limit?": "Up to 250",
                                                                      "created_at_min?": "ISO date"}),
            "get_order": A("GET", "/orders/{order_id}.json", "One order.", {"order_id": "Order id"}),
            "list_products": A("GET", "/products.json", "Products.", {"limit?": "Up to 250"}),
            "list_customers": A("GET", "/customers.json", "Customers.", {"limit?": "Up to 250"}),
        },
    },
    "woocommerce": {
        "label": "WooCommerce", "category": "E-commerce",
        "about": "Orders, products and customers. Read only.",
        "fields": [{"key": "site", "label": "Store address", "secret": False, "placeholder": "https://shop.example.com"},
                   {"key": "key", "label": "Consumer key", "secret": False, "placeholder": "ck_..."},
                   {"key": "secret", "label": "Consumer secret", "secret": True, "placeholder": "cs_..."}],
        "steps": ["WordPress admin > WooCommerce > Settings > Advanced > REST API > Add key.",
                  "Description Agent OS, Permissions Read, Generate API key.",
                  "Copy the consumer key and consumer secret."],
        "base": lambda f: _site(f["site"]) + "/wp-json/wc/v3",
        "headers": lambda f: _basic(f["key"], f["secret"]),
        "test": ("GET", "/products?per_page=1", lambda j: "WooCommerce store" if isinstance(j, list) else None),
        "n8n": ("wooCommerceApi", lambda f: {"consumerKey": f["key"], "consumerSecret": f["secret"], "url": _site(f["site"])}),
        "read_only": True,
        "actions": {
            "list_orders": A("GET", "/orders", "Recent orders.", {"status?": "processing, completed...", "per_page?": "Up to 100",
                                                                 "after?": "ISO date"}),
            "get_order": A("GET", "/orders/{order_id}", "One order.", {"order_id": "Order id"}),
            "list_products": A("GET", "/products", "Products.", {"per_page?": "Up to 100", "search?": "Words"}),
            "list_customers": A("GET", "/customers", "Customers.", {"per_page?": "Up to 100", "search?": "Name or email"}),
        },
    },
    "wordpress": {
        "label": "WordPress", "category": "Website",
        "about": "Posts and pages; agents can save drafts, never publish.",
        "fields": [{"key": "site", "label": "Site address", "secret": False, "placeholder": "https://example.com"},
                   {"key": "user", "label": "Username", "secret": False, "placeholder": "admin user name"},
                   {"key": "password", "label": "Application password", "secret": True, "placeholder": "xxxx xxxx xxxx xxxx"}],
        "steps": ["WordPress admin > Users > Profile > Application Passwords.",
                  "Name it Agent OS, Add New Application Password, and copy it (not your normal password)."],
        "base": lambda f: _site(f["site"]) + "/wp-json/wp/v2",
        "headers": lambda f: _basic(f["user"], f["password"].replace(" ", "")),
        "test": ("GET", "/users/me", lambda j: j.get("name")),
        "n8n": ("wordpressApi", lambda f: {"username": f["user"], "password": f["password"], "url": _site(f["site"])}),
        "actions": {
            "list_posts": A("GET", "/posts", "Posts.", {"status?": "publish or draft", "per_page?": "Up to 100", "search?": "Words"}),
            "list_pages": A("GET", "/pages", "Pages.", {"per_page?": "Up to 100", "search?": "Words"}),
            "create_draft": A("POST", "/posts", "Save a new post as a draft for the owner to publish.",
                              {"title": "Title", "content": "HTML body", "excerpt?": "Summary"}, write=True,
                              fixed={"status": "draft"}),
        },
    },
    "mailchimp": {
        "label": "Mailchimp", "category": "Marketing",
        "about": "Audiences and campaign results. Read only.",
        "fields": [{"key": "token", "label": "API key", "secret": True, "placeholder": "...-us21"}],
        "steps": ["Mailchimp > profile > Extras > API keys > Create A Key.", "Copy the key (it ends in -us and a number)."],
        "base": lambda f: "https://%s.api.mailchimp.com/3.0" % _mc_dc(f["token"]),
        "headers": lambda f: _basic("agentos", f["token"]),
        "test": ("GET", "/", lambda j: j.get("account_name")),
        "n8n": ("mailchimpApi", lambda f: {"apiKey": f["token"]}),
        "read_only": True,
        "actions": {
            "list_audiences": A("GET", "/lists", "Audiences with member counts.", {"count?": "Up to 100"}),
            "list_members": A("GET", "/lists/{list_id}/members", "Members of an audience.",
                              {"list_id": "Audience id", "count?": "Up to 1000", "status?": "subscribed..."}),
            "list_campaigns": A("GET", "/campaigns", "Campaigns.", {"count?": "Up to 100", "status?": "sent, save..."}),
            "campaign_report": A("GET", "/reports/{campaign_id}", "Opens and clicks for a sent campaign.",
                                 {"campaign_id": "Campaign id"}),
        },
    },
    "calendly": {
        "label": "Calendly", "category": "Scheduling",
        "about": "Your booked meetings. Read only.",
        "fields": [{"key": "token", "label": "Personal access token", "secret": True, "placeholder": "eyJ..."}],
        "steps": ["Calendly > Integrations & apps > API and webhooks > Personal access tokens > Generate new token.",
                  "Copy the token."],
        "base": lambda f: "https://api.calendly.com",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/users/me", lambda j: (j.get("resource") or {}).get("email")),
        "n8n": ("calendlyApi", lambda f: {"apiKey": f["token"]}),
        "read_only": True,
        "actions": {
            "me": A("GET", "/users/me", "Your Calendly user (its uri is needed for list_meetings)."),
            "list_meetings": A("GET", "/scheduled_events", "Booked meetings.",
                               {"user": "Your user uri from me", "min_start_time?": "ISO time", "status?": "active",
                                "count?": "Up to 100"}),
        },
    },
    "zendesk": {
        "label": "Zendesk", "category": "Support",
        "about": "Tickets; agents add internal notes only.",
        "fields": [{"key": "sub", "label": "Zendesk sub-domain", "secret": False, "placeholder": "yourcompany"},
                   {"key": "email", "label": "Agent email", "secret": False, "placeholder": "you@company.com"},
                   {"key": "token", "label": "API token", "secret": True, "placeholder": "40 characters"}],
        "steps": ["Zendesk Admin Center > Apps and integrations > APIs > Zendesk API > Settings: turn on Token access.",
                  "Add API token, copy it, and enter your sub-domain and the agent email it belongs to."],
        "base": lambda f: "https://%s.zendesk.com/api/v2" % _host(f["sub"], ".zendesk.com"),
        "headers": lambda f: _basic(f["email"] + "/token", f["token"]),
        "test": ("GET", "/users/me.json", lambda j: (j.get("user") or {}).get("email")),
        "n8n": ("zendeskApi", lambda f: {"subdomain": _host(f["sub"], ".zendesk.com"), "email": f["email"],
                                         "apiToken": f["token"]}),
        "actions": {
            "list_tickets": A("GET", "/tickets.json", "Recent tickets.", {"per_page?": "Up to 100", "sort_order?": "desc"}),
            "search": A("GET", "/search.json", "Search, e.g. type:ticket status:open.", {"query": "Zendesk search"}),
            "get_ticket": A("GET", "/tickets/{ticket_id}/comments.json", "A ticket's conversation.", {"ticket_id": "Ticket id"}),
            "add_internal_note": A("PUT", "/tickets/{ticket_id}.json", "Add a private note (customers do not see it).",
                                   {"ticket_id": "Ticket id", "note": "Text"}, write=True),
        },
    },
    "freshdesk": {
        "label": "Freshdesk", "category": "Support",
        "about": "Tickets; agents add private notes only.",
        "fields": [{"key": "sub", "label": "Freshdesk sub-domain", "secret": False, "placeholder": "yourcompany"},
                   {"key": "token", "label": "API key", "secret": True, "placeholder": "20 characters"}],
        "steps": ["Freshdesk > profile picture > Profile settings.", "Copy Your API Key, and enter your sub-domain."],
        "base": lambda f: "https://%s.freshdesk.com/api/v2" % _host(f["sub"], ".freshdesk.com"),
        "headers": lambda f: _basic(f["token"], "X"),
        "test": ("GET", "/agents/me", lambda j: (j.get("contact") or {}).get("email")),
        "n8n": ("freshdeskApi", lambda f: {"apiKey": f["token"], "domain": _host(f["sub"], ".freshdesk.com")}),
        "actions": {
            "list_tickets": A("GET", "/tickets", "Recent tickets.", {"per_page?": "Up to 100", "filter?": "new_and_my_open..."}),
            "get_ticket": A("GET", "/tickets/{ticket_id}", "One ticket with its conversation.",
                            {"ticket_id": "Ticket id"}, fixed={"include": "conversations"}),
            "add_private_note": A("POST", "/tickets/{ticket_id}/notes", "Add a private note.",
                                  {"ticket_id": "Ticket id", "body": "Text"}, write=True, fixed={"private": True}),
        },
    },
    "pipedrive": {
        "label": "Pipedrive", "category": "CRM & sales",
        "about": "Deals, people and notes.",
        "fields": [{"key": "token", "label": "API token", "secret": True, "placeholder": "40 characters"}],
        "steps": ["Pipedrive > avatar > Personal preferences > API.", "Copy your personal API token."],
        "base": lambda f: "https://api.pipedrive.com/v1",
        "headers": lambda f: {"x-api-token": f["token"]},
        "test": ("GET", "/users/me", lambda j: (j.get("data") or {}).get("email")),
        "n8n": ("pipedriveApi", lambda f: {"apiToken": f["token"]}),
        "actions": {
            "list_deals": A("GET", "/deals", "Deals.", {"status?": "open, won, lost", "limit?": "Up to 500"}),
            "search": A("GET", "/itemSearch", "Search deals, people and organizations.", {"term": "Words"}),
            "list_persons": A("GET", "/persons", "People.", {"limit?": "Up to 500"}),
            "add_note": A("POST", "/notes", "Add a note to a deal or person.",
                          {"content": "Text", "deal_id?": "Deal id", "person_id?": "Person id"}, write=True),
        },
    },
    "unifi": {
        "label": "UniFi Network", "category": "IT & security",
        "about": "Your UniFi gateway, switches and access points: see devices, clients and firewall rules; "
                 "restart a device or update its firmware with your approval.",
        "fields": [{"key": "site", "label": "Controller address", "secret": False,
                    "placeholder": "https://192.168.1.1 or https://unifi.example.com:8443"},
                   {"key": "token", "label": "API key", "secret": True, "placeholder": "From Integrations"}],
        "steps": ["Open your UniFi Network application (version 9 or newer) as an admin.",
                  "Go to Settings > Control Plane > Integrations, create an API key named Agent OS and copy it.",
                  "Enter the address you use to open the controller. The Agent OS box must be able to reach it "
                  "(same network, VPN or Tailscale). Its certificate is remembered on first connect."],
        "base": lambda f: _site(f["site"]) + (f.get("prefix") or "/proxy/network/integration"),
        "headers": lambda f: {"X-API-KEY": f["token"]},
        "prepare": _unifi_prepare, "verify": _unifi_verify,
        "test": ("GET", "/v1/info", lambda j: "UniFi Network " + str(j.get("applicationVersion")) if j.get("applicationVersion") else None),
        "n8n": ("httpHeaderAuth", lambda f: {"name": "X-API-KEY", "value": f["token"]}),
        "actions": {
            "list_sites": A("GET", "/v1/sites", "Sites on this controller (their id is needed by the other actions)."),
            "list_devices": A("GET", "/v1/sites/{site_id}/devices", "Gateways, switches and access points with state, "
                              "firmware version and whether an update is available (firmwareUpdatable).",
                              {"site_id": "Site id", "limit?": "Up to 200", "filter?": "e.g. firmwareUpdatable.eq(true)"}),
            "get_device": A("GET", "/v1/sites/{site_id}/devices/{device_id}", "One device in detail, with ports and radios.",
                            {"site_id": "Site id", "device_id": "Device id"}),
            "device_stats": A("GET", "/v1/sites/{site_id}/devices/{device_id}/statistics/latest", "Uptime, CPU, memory and load.",
                              {"site_id": "Site id", "device_id": "Device id"}),
            "list_clients": A("GET", "/v1/sites/{site_id}/clients", "Connected clients.",
                              {"site_id": "Site id", "limit?": "Up to 200", "filter?": "e.g. type.eq('WIRELESS')"}),
            "list_networks": A("GET", "/v1/sites/{site_id}/networks", "Networks and VLANs.", {"site_id": "Site id"}),
            "list_wifi": A("GET", "/v1/sites/{site_id}/wifi/broadcasts", "Wi-Fi networks.", {"site_id": "Site id"}),
            "list_wans": A("GET", "/v1/sites/{site_id}/wans", "Internet (WAN) connections.", {"site_id": "Site id"}),
            "list_firewall_policies": A("GET", "/v1/sites/{site_id}/firewall/policies", "Firewall rules.",
                                        {"site_id": "Site id", "limit?": "Up to 200"}),
            "list_firewall_zones": A("GET", "/v1/sites/{site_id}/firewall/zones", "Firewall zones.", {"site_id": "Site id"}),
            "list_pending_devices": A("GET", "/v1/pending-devices", "Devices waiting to be adopted."),
            "restart_device": A("POST", "/v1/sites/{site_id}/devices/{device_id}/actions",
                                "Restart a device. Everything behind it drops for a few minutes.",
                                {"site_id": "Site id", "device_id": "Device id"}, fixed={"action": "RESTART"}, approval=True),
            "power_cycle_port": A("POST", "/v1/sites/{site_id}/devices/{device_id}/interfaces/ports/{port_idx}/actions",
                                  "Turn PoE off and on for one switch port, restarting what it powers (a camera, an access point).",
                                  {"site_id": "Site id", "device_id": "Switch id", "port_idx": "Port number"},
                                  fixed={"action": "POWER_CYCLE"}, approval=True),
            "update_firmware": A("POST", "/v1/sites/{site_id}/devices/{device_id}/actions",
                                 "Install the firmware update UniFi offers for a device. It restarts; everything behind "
                                 "it drops for several minutes.",
                                 {"site_id": "Site id", "device_id": "Device id"}, approval=True),
        },
    },
    "cloudflare": {
        "label": "Cloudflare", "category": "IT & security",
        "about": "Domains and DNS records. Read only.",
        "fields": [{"key": "token", "label": "API token", "secret": True, "placeholder": "40 characters"}],
        "steps": ["Cloudflare dashboard > My Profile > API Tokens > Create Token.",
                  "Use Create Custom Token with Zone: Read and DNS: Read for the zones agents may see.",
                  "Copy the token."],
        "base": lambda f: "https://api.cloudflare.com/client/v4",
        "headers": lambda f: _bearer(f["token"]),
        "test": ("GET", "/user/tokens/verify", lambda j: "token %s" % (j.get("result") or {}).get("status")
                 if j.get("success") else None),
        "ok_field": "success",
        "n8n": ("cloudflareApi", lambda f: {"apiToken": f["token"]}),
        "read_only": True,
        "actions": {
            "list_zones": A("GET", "/zones", "Domains on the account.", {"per_page?": "Up to 50"}),
            "list_dns": A("GET", "/zones/{zone_id}/dns_records", "DNS records of a domain.",
                          {"zone_id": "Zone id", "type?": "A, CNAME, MX...", "per_page?": "Up to 100"}),
        },
    },
}

# One-click sign-in apps: they need an app registered with each provider and a sign-in
# page that returns to this box. Shown on the page so owners know what is coming and
# what they can use today instead.
COMING = [
    {"id": "google", "label": "Google Workspace", "category": "Email & calendar",
     "about": "Gmail, Calendar, Drive and Sheets with one-click sign-in.",
     "today": "Gmail works today on the Mailboxes page and Google Calendar on Bookings."},
    {"id": "microsoft", "label": "Microsoft 365", "category": "Email & calendar",
     "about": "Outlook, Calendar, OneDrive, SharePoint and Teams with one-click sign-in.",
     "today": "Outlook mail works today on the Mailboxes page and the calendar on Bookings."},
    {"id": "quickbooks", "label": "QuickBooks Online", "category": "Payments & finance",
     "about": "Invoices, bills and reports.", "today": "Not yet available."},
    {"id": "xero", "label": "Xero", "category": "Payments & finance",
     "about": "Invoices, bills and bank feeds.", "today": "Not yet available."},
    {"id": "salesforce", "label": "Salesforce", "category": "CRM & sales",
     "about": "Accounts, contacts and opportunities.", "today": "Not yet available."},
    {"id": "dropbox", "label": "Dropbox", "category": "Docs & knowledge",
     "about": "Files and folders.", "today": "Not yet available."},
    {"id": "zoom", "label": "Zoom", "category": "Scheduling",
     "about": "Meetings and recordings.", "today": "Not yet available."},
]


def _mc_dc(key):
    m = re.search(r"-([a-z]{2}\d{1,3})$", (key or "").strip())
    if not m:
        raise ValueError("A Mailchimp API key ends with -us and a number, e.g. ...-us21.")
    return m.group(1)


def public_catalog():
    """What the Connections page shows: no functions, no secrets."""
    out = []
    for aid, a in CATALOG.items():
        out.append({"id": aid, "label": a["label"], "category": a["category"], "about": a["about"],
                    "fields": a["fields"], "steps": a["steps"], "read_only": bool(a.get("read_only")),
                    "has_writes": any(x["write"] for x in a["actions"].values()),
                    "actions": [{"name": n, "desc": x["desc"], "write": x["write"], "approval": bool(x.get("approval"))}
                                for n, x in a["actions"].items()]})
    return out


def clean_fields(app_id, raw):
    """The owner's input, trimmed and checked. Raises ValueError with a plain message."""
    a = CATALOG[app_id]
    out = {}
    for f in a["fields"]:
        v = str((raw or {}).get(f["key"]) or "").strip()
        if not v and not f.get("optional"):
            raise ValueError("Fill in %s." % f["label"])
        if len(v) > 600:
            raise ValueError("%s is too long." % f["label"])
        out[f["key"]] = v
    a["base"](out)          # checks addresses and sub-domains
    return out


def secrets_of(app_id, fields):
    return [fields[f["key"]] for f in CATALOG[app_id]["fields"] if f.get("secret") and fields.get(f["key"])]


def _scrub(text, secrets):
    text = str(text or "")
    for s in secrets:
        if s and len(s) >= 6:
            text = text.replace(s, "[redacted]")
    return text


def prepare(app_id, fields):
    """App-specific setup at connect time (find the API, remember a certificate)."""
    fn = CATALOG[app_id].get("prepare")
    return fn(fields) if fn else fields


def _send(app_id, fields, method, path, query=None, body=None, url=None):
    a = CATALOG[app_id]
    url = url or (a["base"](fields) + path)
    verify = a["verify"](fields) if a.get("verify") else True
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, verify=verify) as c:
        r = c.request(method, url, headers=dict(a["headers"](fields), **{"Accept": "application/json",
                                                                       "User-Agent": "SuburbanCyber-AgentOS/1"}),
                      params=query or None, json=body if method != "GET" else None)
    try:
        data = r.json()
    except Exception:
        data = {"text": r.text[:4000]}
    if r.status_code >= 400:
        msg = data.get("message") or data.get("error") or data.get("errors") if isinstance(data, dict) else None
        raise RuntimeError("%s answered %s: %s" % (a["label"], r.status_code,
                                                    _scrub(json.dumps(msg) if msg else r.text, secrets_of(app_id, fields))[:400]))
    okf = a.get("ok_field")
    if okf and isinstance(data, dict) and data.get(okf) is False:
        raise RuntimeError("%s refused: %s" % (a["label"], _scrub(json.dumps(data.get("error") or data.get("errors")),
                                                                  secrets_of(app_id, fields))[:400]))
    if a.get("graphql") and isinstance(data, dict) and data.get("errors"):
        raise RuntimeError("%s refused the query: %s" % (a["label"], json.dumps(data["errors"])[:400]))
    return data


def test(app_id, fields):
    """Make the app's 'who am I' call. Returns a short description of the account."""
    t = CATALOG[app_id]["test"]
    method, path, who = t[0], t[1], t[2]
    q = None
    if "?" in path:
        path, qs = path.split("?", 1)
        q = dict(p.split("=", 1) for p in qs.split("&"))
    data = _send(app_id, fields, method, path, query=q, body=t[3] if len(t) > 3 else None)
    name = who(data) if isinstance(data, (dict, list)) else None
    if not name:
        raise RuntimeError("%s did not confirm the login." % CATALOG[app_id]["label"])
    return str(name)[:120]


_MUTATION = re.compile(r"^\s*mutation\b|\bmutation\s*[({]", re.I)


def _unifi_dev(fields, p):
    return _send("unifi", fields, "GET", "/v1/sites/%s/devices/%s" % (p["site_id"], p["device_id"]))


def describe(app_id, fields, action, params):
    """Before the owner is asked: check the target is real and say exactly what would happen.
    Returns {"target", "detail", "state"}; raises ValueError when the action makes no sense now."""
    spec = CATALOG[app_id]["actions"][action]
    if app_id != "unifi":
        return {"target": CATALOG[app_id]["label"], "detail": spec["desc"], "state": {}}
    for k in ("site_id", "device_id"):
        if not re.match(r"^[A-Za-z0-9-]{1,64}$", str((params or {}).get(k) or "")):
            raise ValueError("%s needs %s (from list_sites and list_devices)." % (action, k))
    d = _unifi_dev(fields, params)
    name = "%s (%s, %s)" % (d.get("name") or "device", d.get("model") or "UniFi", d.get("ipAddress") or d.get("macAddress") or "")
    st = {"state": d.get("state"), "firmware": d.get("firmwareVersion"), "updatable": bool(d.get("firmwareUpdatable")),
          "mac": d.get("macAddress")}
    if str(d.get("state")).upper() != "ONLINE":
        raise ValueError("%s is %s, not online, so this cannot run now." % (name, str(d.get("state")).lower()))
    if action == "update_firmware":
        if not d.get("firmwareUpdatable"):
            raise ValueError("%s has no firmware update waiting (it is on %s)." % (name, d.get("firmwareVersion")))
        detail = "Installs the firmware update UniFi offers (now on %s). The device restarts; expect several minutes offline." % d.get("firmwareVersion")
    elif action == "power_cycle_port":
        detail = "Turns PoE off and on for port %s, restarting what that port powers." % params.get("port_idx")
    else:
        detail = "Restarts the device. Everything connected through it drops for a few minutes."
    return {"target": name, "detail": detail, "state": st}


def _mins(sec):
    m = max(1, round(sec / 60))
    return "%d minute%s" % (m, "" if m == 1 else "s")


def confirm(app_id, fields, action, params, before, started):
    """After an approved action: (finished, worked, plain result). Called repeatedly until finished."""
    if app_id != "unifi" or action == "power_cycle_port":
        return True, True, "Done."
    waited = time.time() - started
    try:
        d = _unifi_dev(fields, params)
    except Exception as e:
        if waited > 900:
            return True, False, "The controller stopped answering and had not come back after 15 minutes (%s)." % str(e)[:120]
        return False, False, ""
    online = str(d.get("state")).upper() == "ONLINE"
    if action == "restart_device":
        if online and waited > 90:
            return True, True, "It is back online after about %s." % _mins(waited)
    else:
        if online and d.get("firmwareVersion") != before.get("firmware"):
            return True, True, "Firmware went from %s to %s and the device is back online after about %s." % (
                before.get("firmware"), d.get("firmwareVersion"), _mins(waited))
        if online and waited > 1200:
            return True, False, "The device is online but still on firmware %s after 20 minutes: the update did not install." % d.get("firmwareVersion")
    if waited > 1500:
        return True, False, "The device had not come back online after 25 minutes (last state: %s). Check it on site." % str(d.get("state")).lower()
    return False, False, ""


def run(app_id, fields, action, params, allow_write, approved=False):
    """Run one named action. Returns the app's answer (JSON-able)."""
    a = CATALOG[app_id]
    if action not in a["actions"]:
        raise ValueError("%s has no action %r. Actions: %s." % (a["label"], action, ", ".join(a["actions"])))
    spec = a["actions"][action]
    if spec["write"] and not allow_write:
        raise PermissionError("The owner set %s to read only, so %s is not allowed." % (a["label"], action))
    if spec.get("approval") and not approved:
        raise PermissionError("%s can interrupt the business, so it needs the owner's approval. Call propose_action "
                              "with the same app, action and params; the owner gets a card, and Agent OS runs it "
                              "and checks the result when they approve." % action)
    p = dict(params or {})
    names = {k.rstrip("?"): k.endswith("?") for k in spec["params"]}
    for k, opt in names.items():
        if not opt and (k not in p or p[k] in (None, "")):
            raise ValueError("%s needs %s." % (action, k))
    unknown = [k for k in p if k not in names]
    if unknown:
        raise ValueError("%s does not take %s. It takes: %s." % (action, ", ".join(unknown), ", ".join(names) or "nothing"))
    path = spec["path"]
    for k in re.findall(r"{(\w+)}", path):
        v = str(p.pop(k))
        if not re.match(r"^[A-Za-z0-9._~@:%+=,-][A-Za-z0-9._~@:%+=,/ -]*$", v) or ".." in v:
            raise ValueError("%s is not a valid value." % k)
        path = path.replace("{%s}" % k, httpx.URL("http://x/" + v).raw_path.decode()[1:] if k == "path" else
                            v.replace("/", "%2F").replace(" ", "%20"))
    p.update(spec["fixed"])
    # App-specific shapes
    if app_id == "unifi" and action == "update_firmware":
        # The official API has no firmware action yet; the controller's own command does it.
        dev = _unifi_dev(fields, params)
        sites = _send("unifi", fields, "GET", "/v1/sites", query={"limit": 200})
        ref = next((x.get("internalReference") for x in (sites.get("data") or []) if str(x.get("id")) == str(params["site_id"])), None)
        if not ref or not dev.get("macAddress"):
            raise RuntimeError("Could not look up the device or its site on the controller.")
        root = _site(fields["site"]) + ("/proxy/network" if str(fields.get("prefix") or "").startswith("/proxy") else "")
        return _send("unifi", fields, "POST", "", url="%s/api/s/%s/cmd/devmgr" % (root, ref),
                     body={"cmd": "upgrade", "mac": str(dev["macAddress"]).lower()})
    if app_id in ("linear", "monday"):
        if action == "query":
            if _MUTATION.search(str(p.get("query") or "")):
                raise PermissionError("query is read only; use the named write actions to change things.")
            body = {"query": p["query"], "variables": p.get("variables") or {}}
        elif app_id == "linear":
            body = {"query": "mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url } } }",
                    "variables": {"i": {k: v for k, v in p.items()}}}
        else:
            body = {"query": "mutation($b: ID!, $n: String!, $g: String) { create_item(board_id: $b, item_name: $n, "
                             "group_id: $g) { id } }",
                    "variables": {"b": str(p["board_id"]), "n": p["item_name"], "g": p.get("group_id")}}
        return _send(app_id, fields, "POST", path, body=body)
    if app_id == "jira" and action == "create_issue":
        body = {"fields": {"project": {"key": p["project"]}, "summary": p["summary"],
                           "issuetype": {"name": p.get("issuetype") or "Task"}}}
        if p.get("description"):
            body["fields"]["description"] = _txt_adf(p["description"])
        return _send(app_id, fields, "POST", path, body=body)
    if app_id == "jira" and action == "comment_issue":
        return _send(app_id, fields, "POST", path, body={"body": _txt_adf(p["body"])})
    if app_id == "zendesk" and action == "add_internal_note":
        return _send(app_id, fields, "PUT", path, body={"ticket": {"comment": {"body": p["note"], "public": False}}})
    if app_id == "hubspot" and action.startswith("search_"):
        return _send(app_id, fields, "POST", path, body={"query": p["query"], "limit": int(p.get("limit") or 20)})
    if spec["method"] == "GET":
        return _send(app_id, fields, "GET", path, query={k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
                                                          for k, v in p.items()})
    body = p
    if spec["wrap"]:
        body = {spec["wrap"]: p}
    return _send(app_id, fields, spec["method"], path, body=body)


def n8n_credential(app_id, fields):
    """(n8n credential type, data) for the same login."""
    t, fn = CATALOG[app_id]["n8n"]
    return t, {k: v for k, v in fn(fields).items() if v not in (None, "")}


def trim(data):
    s = json.dumps(data, default=str)
    if len(s) <= MAX_OUT:
        return s
    return s[:MAX_OUT] + ' ... [cut: the answer was %d characters; ask for fewer items or a smaller page]' % len(s)
