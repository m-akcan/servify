import os, socket
from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def root():
    return {"hello": "from servify", "lang": "python", "host": socket.gethostname(), "replica": os.environ.get("SERVIFY_REPLICA_INDEX")}
