from web_api.canvas_module import media_urls, rewrite_source


def test_prompt_annotations_keep_literal_local_looking_urls_in_both_directions():
    annotations = {"url": "/api/manual-note", "nested": {"href": "/canvas-module/media/literal"}}
    source = {"url": "/media/asset", "recommendations": annotations, "nativeSource": {"record": annotations}, "result": {"href": "/api/real-result"}}
    mounted = media_urls(source)
    assert mounted["url"] == "/canvas-module/media/asset"
    assert mounted["result"]["href"] == "/canvas-module/api/real-result"
    assert mounted["recommendations"] == annotations
    assert mounted["nativeSource"]["record"] == annotations
    assert media_urls(mounted, reverse=True) == source
    assert source["url"] == "/media/asset"


def test_prompt_module_root_urls_still_mount_without_touching_opaque_json_strings():
    text = "fetch('/api/prompt-catalog/native-export/preview'); const x={recommendations:{url:'/notes/plain'}};"
    result = rewrite_source(text, native_path='/prompt-catalog.js')
    assert "fetch('/canvas-module/api/prompt-catalog/native-export/preview')" in result
    assert "url:'/notes/plain'" in result
