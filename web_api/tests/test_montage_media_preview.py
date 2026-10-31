"""The director's reference preview must use the existing media endpoint."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from web_api.footage_api import create_footage_router


def test_reference_import_and_project_video_preview_keep_range_support(tmp_path):
    project = tmp_path / 'preview-project'
    data = b'0123456789abcdef'
    app = FastAPI()
    app.include_router(create_footage_router(tmp_path))
    with TestClient(app) as client:
        for relative in ('assets/video/source.mp4', 'analysis/reference_imports/source.mp4'):
            source = project / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(data)
            response = client.get('/model-api/footage/assets/preview-project', params={'path': relative})
            assert response.status_code == 200
            assert response.content == data
            assert response.headers['content-type'] == 'video/mp4'
            assert response.headers['x-content-type-options'] == 'nosniff'
            part = client.get('/model-api/footage/assets/preview-project',
                              params={'path': relative}, headers={'Range': 'bytes=3-7'})
            assert part.status_code == 206
            assert part.content == data[3:8]


def test_reference_preview_cannot_read_other_projects_or_configuration(tmp_path):
    project = tmp_path / 'preview-project'
    project.mkdir()
    (project / 'hypit.runtime.json').write_text('{"credential":"fixture"}')
    other = tmp_path / 'other-project'
    other.mkdir()
    (other / 'source.mp4').write_bytes(b'other-video')
    app = FastAPI()
    app.include_router(create_footage_router(tmp_path))
    with TestClient(app) as client:
        for path in ('../other-project/source.mp4', str(other / 'source.mp4'), 'hypit.runtime.json'):
            response = client.get('/model-api/footage/assets/preview-project', params={'path': path})
            assert response.status_code in (400, 403, 404, 422)
