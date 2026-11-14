FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# ssh client: used only to change an agent's model on its own machine (scripts/agent-ssh.sh).
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY app.py mcp_config.py store_agent_models.py agent_templates.json ./
ENV CONNECTORS_DB=/data/connectors.db
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
