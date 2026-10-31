from backlot.state import _scan_media


def test_local_tool_images_survive_reload_without_following_external_symlinks(tmp_path):
    project = tmp_path / 'project'
    images = project / 'assets/local-tools/bg_remove'
    images.mkdir(parents=True)
    (images / 'cutout.png').write_bytes(b'test')
    outside = tmp_path / 'private.png'
    outside.write_bytes(b'private')
    (images / 'outside.png').symlink_to(outside)
    paths = [item['path'] for item in _scan_media(project)['snapshots']]
    assert paths == ['assets/local-tools/bg_remove/cutout.png']
