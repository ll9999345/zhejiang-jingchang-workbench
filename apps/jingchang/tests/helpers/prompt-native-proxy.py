"""Owned loopback-only HTTP fixture: real V2 canvas router, isolated native data."""
import sys
from pathlib import Path
root = Path('/Users/mjd-ppps/生视频/浙江文旅AI视频引擎V2')
sys.path.insert(0, str(root))
from fastapi import FastAPI
from web_api.canvas_module import create_canvas_module_router
import uvicorn
app = FastAPI()
app.include_router(create_canvas_module_router(root, bridge=object(), engine_port=int(sys.argv[1])))
uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')
