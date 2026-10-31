// Captured from real local mocked-Comfy acceptance on 2026-10-07.
// Synthetic PNG media and loopback requests only; no cloud calls or credentials.
export const cascadeFixtures=[
  {
    "scenario": "random-list",
    "project": {
      "id": "cascade-project",
      "name": "智能串联规则样本",
      "revision": 0,
      "createdAt": "2026-10-07T08:26:01.772Z",
      "updatedAt": "2026-10-07T08:26:01.772Z",
      "nodes": [
        {
          "id": "A",
          "type": "image",
          "x": 0,
          "y": 0,
          "title": "A",
          "text": "",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-A",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-A",
                    "name": "A.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-A"
                },
                "promptDraftHtml": "",
                "promptDraftText": ""
              },
              "resources": [
                {
                  "url": "/api/assets/asset-A",
                  "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                  "archive": "media/A.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "793c1af5-a1ea-495e-a540-d4fea647b45a"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
              "overrides": [
                {
                  "nodeId": "4",
                  "name": "seed",
                  "value": 10000
                }
              ],
              "imageSources": [],
              "promptBatch": {
                "nodeId": "1",
                "name": "text",
                "values": [
                  "第一条《计数》与 @原图",
                  "第二条 <literal>",
                  "第三条《总数》"
                ]
              },
              "incrementSeeds": false
            }
          }
        },
        {
          "id": "B",
          "type": "image",
          "x": 300,
          "y": 0,
          "title": "B",
          "text": "独立提示 B",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-B",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-B",
                    "name": "B.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-B"
                },
                "promptDraftHtml": "参数属于 B",
                "promptDraftText": "参数属于 B"
              },
              "resources": [
                {
                  "url": "/api/assets/asset-B",
                  "assetId": "b8d7f326-6db5-4c05-b5a0-472f82e9f94a",
                  "archive": "media/B.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "b8d7f326-6db5-4c05-b5a0-472f82e9f94a"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "d8347eea-1698-4abf-8a43-81cd328bbff8",
              "count": 1,
              "overrides": [],
              "imageSources": [],
              "promptField": {
                "nodeId": "1",
                "name": "text"
              }
            }
          }
        },
        {
          "id": "C",
          "type": "image",
          "x": 600,
          "y": 0,
          "title": "C",
          "text": "独立提示 C",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-C",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-C",
                    "name": "C.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-C"
                },
                "promptDraftHtml": "参数属于 C",
                "promptDraftText": "参数属于 C"
              },
              "resources": [
                {
                  "url": "/api/assets/asset-C",
                  "assetId": "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1",
                  "archive": "media/C.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "d8347eea-1698-4abf-8a43-81cd328bbff8",
              "count": 1,
              "overrides": [],
              "imageSources": [],
              "promptField": {
                "nodeId": "1",
                "name": "text"
              }
            }
          }
        }
      ],
      "edges": [
        {
          "id": "edge-0",
          "source": "A",
          "target": "B",
          "nativeCanvasConnection": {
            "from": "original-A",
            "to": "original-B",
            "kind": "flow"
          }
        },
        {
          "id": "edge-1",
          "source": "A",
          "target": "C",
          "nativeCanvasConnection": {
            "from": "original-A",
            "to": "original-C",
            "kind": "flow"
          }
        }
      ],
      "assets": [
        {
          "id": "793c1af5-a1ea-495e-a540-d4fea647b45a",
          "name": "A.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:26:01.772Z",
          "url": "/media/793c1af5-a1ea-495e-a540-d4fea647b45a"
        },
        {
          "id": "b8d7f326-6db5-4c05-b5a0-472f82e9f94a",
          "name": "B.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:26:01.774Z",
          "url": "/media/b8d7f326-6db5-4c05-b5a0-472f82e9f94a"
        },
        {
          "id": "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1",
          "name": "C.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:26:01.776Z",
          "url": "/media/bb8b84f3-7da1-404c-9107-3d8c40a9a0e1"
        }
      ],
      "shots": [],
      "messages": [],
      "runs": [],
      "viewport": {
        "x": 0,
        "y": 0,
        "zoom": 1
      },
      "settings": {
        "ratio": "16:9",
        "fps": 24
      },
      "archived": false
    },
    "jobs": [
      {
        "id": "a12049e7-3485-4a4f-a8e0-6cc01f217078",
        "kind": "comfy",
        "projectId": "cascade-project",
        "parentId": "aa580365-7555-4153-b2f3-f6162c41119a",
        "requestId": "cascade-child-d52103693f49b90728accce362a6ac922b5f0de65983f7a4f56ea54bd7bfd8ad",
        "revision": 0,
        "name": "isolated cascade specialized",
        "workflowId": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:60265"
        },
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "template literal"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "fixture-reference.png"
            }
          },
          "4": {
            "class_type": "KSampler",
            "inputs": {
              "seed": 30
            }
          }
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:60265",
          "network": "local"
        },
        "count": 3,
        "promptBatch": {
          "nodeId": "1",
          "name": "text",
          "values": [
            "第一条《计数》与 @原图",
            "第二条 <literal>",
            "第三条《总数》"
          ]
        },
        "incrementSeeds": false,
        "target": {
          "id": "A",
          "assetId": null,
          "text": ""
        },
        "createdAt": "2026-10-07T08:26:01.821Z",
        "status": "completed",
        "progress": 100,
        "message": "已生成 3 份素材，可加入项目",
        "items": [
          {
            "index": 0,
            "status": "completed",
            "promptId": "fixture-0",
            "assets": [
              {
                "id": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                "outputKey": "[\"2\",\"fixture-0-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第一条《计数》与 @原图"
          },
          {
            "index": 1,
            "status": "completed",
            "promptId": "fixture-1",
            "assets": [
              {
                "id": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                "outputKey": "[\"2\",\"fixture-1-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第二条 <literal>"
          },
          {
            "index": 2,
            "status": "completed",
            "promptId": "fixture-2",
            "assets": [
              {
                "id": "8f857870-1c99-45f1-8f39-72d8b946f595",
                "outputKey": "[\"2\",\"fixture-2-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第三条《总数》"
          }
        ],
        "assets": [
          {
            "id": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
            "name": "fixture-0-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:26:01.857Z",
            "url": "/media/16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
            "batchIndex": 0
          },
          {
            "id": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
            "name": "fixture-1-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:26:01.902Z",
            "url": "/media/696d174d-95ba-4432-b569-f20c7ecc9fe4",
            "batchIndex": 1
          },
          {
            "id": "8f857870-1c99-45f1-8f39-72d8b946f595",
            "name": "fixture-2-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:26:01.918Z",
            "url": "/media/8f857870-1c99-45f1-8f39-72d8b946f595",
            "batchIndex": 2
          }
        ],
        "applied": false,
        "randomFields": [
          {
            "nodeId": "4",
            "name": "seed"
          }
        ],
        "workflowRandom": {
          "version": 1,
          "policy": "infinite-canvas-number-v1",
          "count": 3,
          "fields": [
            {
              "nodeId": "4",
              "name": "seed",
              "label": "seed",
              "min": 1,
              "max": 100,
              "isFloat": false,
              "precision": 0
            }
          ],
          "batches": [
            {
              "index": 0,
              "values": [
                {
                  "nodeId": "4",
                  "name": "seed",
                  "value": 42
                }
              ]
            },
            {
              "index": 1,
              "values": [
                {
                  "nodeId": "4",
                  "name": "seed",
                  "value": 56
                }
              ]
            },
            {
              "index": 2,
              "values": [
                {
                  "nodeId": "4",
                  "name": "seed",
                  "value": 76
                }
              ]
            }
          ]
        },
        "imageBindings": [
          {
            "nodeId": "3",
            "name": "image",
            "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a"
          }
        ],
        "inputMappings": [
          {
            "nodeId": "3",
            "name": "image",
            "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
            "uploaded": {
              "name": "fixture-reference.png",
              "subfolder": "",
              "type": "input"
            },
            "value": "fixture-reference.png"
          }
        ],
        "inputPrepared": true,
        "inputPreparation": "completed",
        "cascadeBatch": {
          "promptBatch": {
            "nodeId": "1",
            "name": "text",
            "values": [
              "第一条《计数》与 @原图",
              "第二条 <literal>",
              "第三条《总数》"
            ]
          },
          "batchExecution": {
            "workflowId": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
            "workflowRevision": 2,
            "count": 3,
            "seedOffset": 0,
            "incrementSeeds": false,
            "randomFields": [
              {
                "nodeId": "4",
                "name": "seed"
              }
            ],
            "imageBindings": [
              {
                "nodeId": "3",
                "name": "image",
                "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a"
              }
            ],
            "mediaDefaults": [
              {
                "nodeId": "3",
                "name": "image",
                "value": "original.png"
              }
            ],
            "workflowHash": "6ee391fc5df5e8fa12d93a5bb5429ca53d232aa7f4b9844e1019edae0dd34880"
          },
          "workflowRandom": {
            "version": 1,
            "policy": "infinite-canvas-number-v1",
            "count": 3,
            "fields": [
              {
                "nodeId": "4",
                "name": "seed",
                "label": "seed",
                "min": 1,
                "max": 100,
                "isFloat": false,
                "precision": 0
              }
            ],
            "batches": [
              {
                "index": 0,
                "values": [
                  {
                    "nodeId": "4",
                    "name": "seed",
                    "value": 42
                  }
                ]
              },
              {
                "index": 1,
                "values": [
                  {
                    "nodeId": "4",
                    "name": "seed",
                    "value": 56
                  }
                ]
              },
              {
                "index": 2,
                "values": [
                  {
                    "nodeId": "4",
                    "name": "seed",
                    "value": 76
                  }
                ]
              }
            ]
          }
        }
      },
      {
        "id": "aa580365-7555-4153-b2f3-f6162c41119a",
        "kind": "canvas-run",
        "executionMode": "native-cascade",
        "projectId": "cascade-project",
        "nodeId": "C",
        "requestId": "specialized-parent",
        "revision": 0,
        "name": "智能串联规则样本 · 智能串联",
        "createdAt": "2026-10-07T08:26:01.799Z",
        "status": "completed",
        "progress": 100,
        "message": "智能串联完成：3 份新素材，传递记录已保留，可检查后加入画布",
        "assets": [
          {
            "id": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
            "name": "fixture-0-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:26:01.857Z",
            "url": "/media/16d52a66-72c6-4e1d-9309-81b6bd5c8b6f"
          },
          {
            "id": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
            "name": "fixture-1-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:26:01.902Z",
            "url": "/media/696d174d-95ba-4432-b569-f20c7ecc9fe4"
          },
          {
            "id": "8f857870-1c99-45f1-8f39-72d8b946f595",
            "name": "fixture-2-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:26:01.918Z",
            "url": "/media/8f857870-1c99-45f1-8f39-72d8b946f595"
          }
        ],
        "textResults": [],
        "steps": [
          {
            "executionId": "cascade-r0-s0",
            "nodeId": "A",
            "title": "A → B",
            "cascadeKind": "generate",
            "sourceNodeId": "A",
            "targetNodeId": "B",
            "count": 3,
            "status": "completed",
            "roundIndex": 0,
            "roundCount": 1,
            "kind": "comfy",
            "text": "",
            "sendAssets": true,
            "promptBatch": {
              "nodeId": "1",
              "name": "text",
              "values": [
                "第一条《计数》与 @原图",
                "第二条 <literal>",
                "第三条《总数》"
              ]
            },
            "workflowId": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
            "workflowRevision": 2,
            "actualInput": {
              "version": 1,
              "prompt": "",
              "displayPrompt": "",
              "roles": [
                {
                  "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                  "kind": "image",
                  "role": "image_1"
                }
              ],
              "referenceRefs": [
                {
                  "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                  "kind": "image",
                  "name": "A.png",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "mappings": [
                {
                  "nodeId": "3",
                  "name": "image",
                  "kind": "image",
                  "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "unusedRefs": [],
              "promptFields": [],
              "providerRequestCount": 3,
              "promptBatch": {
                "nodeId": "1",
                "name": "text",
                "values": [
                  "第一条《计数》与 @原图",
                  "第二条 <literal>",
                  "第三条《总数》"
                ]
              },
              "batchExecution": {
                "workflowId": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
                "workflowRevision": 2,
                "count": 3,
                "seedOffset": 0,
                "incrementSeeds": false,
                "randomFields": [
                  {
                    "nodeId": "4",
                    "name": "seed"
                  }
                ],
                "imageBindings": [
                  {
                    "nodeId": "3",
                    "name": "image",
                    "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a"
                  }
                ],
                "mediaDefaults": [
                  {
                    "nodeId": "3",
                    "name": "image",
                    "value": "original.png"
                  }
                ],
                "workflowHash": "6ee391fc5df5e8fa12d93a5bb5429ca53d232aa7f4b9844e1019edae0dd34880"
              },
              "workflowRandom": {
                "version": 1,
                "policy": "infinite-canvas-number-v1",
                "count": 3,
                "fields": [
                  {
                    "nodeId": "4",
                    "name": "seed",
                    "label": "seed",
                    "min": 1,
                    "max": 100,
                    "isFloat": false,
                    "precision": 0
                  }
                ],
                "batches": [
                  {
                    "index": 0,
                    "values": [
                      {
                        "nodeId": "4",
                        "name": "seed",
                        "value": 42
                      }
                    ]
                  },
                  {
                    "index": 1,
                    "values": [
                      {
                        "nodeId": "4",
                        "name": "seed",
                        "value": 56
                      }
                    ]
                  },
                  {
                    "index": 2,
                    "values": [
                      {
                        "nodeId": "4",
                        "name": "seed",
                        "value": 76
                      }
                    ]
                  }
                ]
              }
            },
            "jobId": "a12049e7-3485-4a4f-a8e0-6cc01f217078",
            "childRequests": {
              "count": 3,
              "submitted": 3,
              "completed": 3,
              "items": [
                {
                  "index": 0,
                  "status": "completed",
                  "promptId": "fixture-0"
                },
                {
                  "index": 1,
                  "status": "completed",
                  "promptId": "fixture-1"
                },
                {
                  "index": 2,
                  "status": "completed",
                  "promptId": "fixture-2"
                }
              ]
            }
          },
          {
            "executionId": "cascade-r0-s1",
            "nodeId": "A",
            "title": "A → C",
            "cascadeKind": "copy",
            "sourceNodeId": "A",
            "targetNodeId": "C",
            "count": 0,
            "status": "completed",
            "roundIndex": 0,
            "roundCount": 1,
            "kind": "cascade-copy"
          }
        ],
        "summary": {
          "operations": 2,
          "generations": 1,
          "requests": 3,
          "sharedCopies": 1,
          "relays": 0
        },
        "snapshot": {
          "id": "cascade-project",
          "name": "智能串联规则样本",
          "revision": 0,
          "createdAt": "2026-10-07T08:26:01.772Z",
          "updatedAt": "2026-10-07T08:26:01.772Z",
          "nodes": [
            {
              "id": "A",
              "type": "image",
              "x": 0,
              "y": 0,
              "title": "A",
              "text": "",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-A",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-A",
                        "name": "A.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-A"
                    },
                    "promptDraftHtml": "",
                    "promptDraftText": ""
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-A",
                      "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                      "archive": "media/A.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "793c1af5-a1ea-495e-a540-d4fea647b45a"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
                  "overrides": [
                    {
                      "nodeId": "4",
                      "name": "seed",
                      "value": 10000
                    }
                  ],
                  "imageSources": [],
                  "promptBatch": {
                    "nodeId": "1",
                    "name": "text",
                    "values": [
                      "第一条《计数》与 @原图",
                      "第二条 <literal>",
                      "第三条《总数》"
                    ]
                  },
                  "incrementSeeds": false
                }
              }
            },
            {
              "id": "B",
              "type": "image",
              "x": 300,
              "y": 0,
              "title": "B",
              "text": "独立提示 B",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-B",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-B",
                        "name": "B.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-B"
                    },
                    "promptDraftHtml": "参数属于 B",
                    "promptDraftText": "参数属于 B"
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-B",
                      "assetId": "b8d7f326-6db5-4c05-b5a0-472f82e9f94a",
                      "archive": "media/B.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "b8d7f326-6db5-4c05-b5a0-472f82e9f94a"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "d8347eea-1698-4abf-8a43-81cd328bbff8",
                  "count": 1,
                  "overrides": [],
                  "imageSources": [],
                  "promptField": {
                    "nodeId": "1",
                    "name": "text"
                  }
                }
              }
            },
            {
              "id": "C",
              "type": "image",
              "x": 600,
              "y": 0,
              "title": "C",
              "text": "独立提示 C",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-C",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-C",
                        "name": "C.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-C"
                    },
                    "promptDraftHtml": "参数属于 C",
                    "promptDraftText": "参数属于 C"
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-C",
                      "assetId": "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1",
                      "archive": "media/C.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "d8347eea-1698-4abf-8a43-81cd328bbff8",
                  "count": 1,
                  "overrides": [],
                  "imageSources": [],
                  "promptField": {
                    "nodeId": "1",
                    "name": "text"
                  }
                }
              }
            }
          ],
          "edges": [
            {
              "id": "edge-0",
              "source": "A",
              "target": "B",
              "nativeCanvasConnection": {
                "from": "original-A",
                "to": "original-B",
                "kind": "flow"
              }
            },
            {
              "id": "edge-1",
              "source": "A",
              "target": "C",
              "nativeCanvasConnection": {
                "from": "original-A",
                "to": "original-C",
                "kind": "flow"
              }
            }
          ],
          "assets": [
            {
              "id": "793c1af5-a1ea-495e-a540-d4fea647b45a",
              "name": "A.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:26:01.772Z",
              "url": "/media/793c1af5-a1ea-495e-a540-d4fea647b45a"
            },
            {
              "id": "b8d7f326-6db5-4c05-b5a0-472f82e9f94a",
              "name": "B.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:26:01.774Z",
              "url": "/media/b8d7f326-6db5-4c05-b5a0-472f82e9f94a"
            },
            {
              "id": "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1",
              "name": "C.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:26:01.776Z",
              "url": "/media/bb8b84f3-7da1-404c-9107-3d8c40a9a0e1"
            }
          ],
          "shots": [],
          "messages": [],
          "runs": [],
          "viewport": {
            "x": 0,
            "y": 0,
            "zoom": 1
          },
          "settings": {
            "ratio": "16:9",
            "fps": 24
          },
          "archived": false
        },
        "cascadeProgram": {
          "version": 1,
          "mode": "native-cascade",
          "requestedNodeId": "C",
          "tailNodeId": "C",
          "rootNodeId": "A",
          "pathNodeIds": [
            "A",
            "C"
          ],
          "singleNodeLoopRun": false,
          "loop": null,
          "scheduling": {
            "mode": "serial",
            "parallelLimitPolicy": "comfy-backends-at-most-six"
          },
          "operationCount": 2,
          "generationOperationCount": 1,
          "rounds": [
            {
              "roundIndex": 0,
              "index": null,
              "total": null,
              "forceWorkflow": false,
              "loopContexts": {},
              "choices": [],
              "operations": [
                {
                  "id": "cascade-r0-s0",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "target": {
                    "kind": "node",
                    "nodeId": "B"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "generate",
                  "requestNodeId": "A",
                  "references": {
                    "kind": "self-default-incoming",
                    "selfNodeId": "A",
                    "defaultNodeId": "A",
                    "incoming": {
                      "kind": "default",
                      "nodeId": "A"
                    }
                  },
                  "resultPolicy": "replace-with-history",
                  "missingPromptFallback": {
                    "reference": {
                      "kind": "default",
                      "nodeId": "A"
                    },
                    "resultPolicy": "replace-with-history"
                  }
                },
                {
                  "id": "cascade-r0-s1",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "target": {
                    "kind": "node",
                    "nodeId": "C"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "copy",
                  "requestNodeId": null,
                  "references": {
                    "kind": "operation-output",
                    "operationId": "cascade-r0-s0"
                  },
                  "resultPolicy": "replace-with-history",
                  "missingPromptFallback": null
                }
              ],
              "skippedNodeIds": []
            }
          ]
        },
        "cascadeState": {
          "version": 1,
          "snapshotDigest": "f34d846af421e344a082f2707e55754a45dcd01a3bda37ef3b7e727bcd4b679d",
          "programDigest": "14a800e2da3660ab67f9d6b9a15d72f67dbc1d594d6ab04ea1b6ea277fe6ff7b",
          "status": "completed",
          "completedOperationCount": 2,
          "completedOrder": [
            "0:cascade-r0-s0",
            "0:cascade-r0-s1"
          ],
          "receivers": {
            "B": {
              "currentRefs": [
                {
                  "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                  "kind": "image",
                  "name": "fixture-0-0.png",
                  "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8"
                },
                {
                  "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                  "kind": "image",
                  "name": "fixture-1-0.png",
                  "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79"
                },
                {
                  "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                  "kind": "image",
                  "name": "fixture-2-0.png",
                  "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd"
                }
              ],
              "historyRefs": [
                {
                  "assetId": "b8d7f326-6db5-4c05-b5a0-472f82e9f94a",
                  "kind": "image",
                  "name": "B.png",
                  "identity": "bca08324d532859c52cb8814f61ddf2f010927987e1ea6d1ff8d90ad5fedb7f6"
                }
              ],
              "appendInitialized": false
            },
            "C": {
              "currentRefs": [
                {
                  "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                  "kind": "image",
                  "name": "fixture-0-0.png",
                  "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8"
                },
                {
                  "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                  "kind": "image",
                  "name": "fixture-1-0.png",
                  "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79"
                },
                {
                  "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                  "kind": "image",
                  "name": "fixture-2-0.png",
                  "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd"
                }
              ],
              "historyRefs": [
                {
                  "assetId": "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1",
                  "kind": "image",
                  "name": "C.png",
                  "identity": "15bbbe01d7a0a4a430658ac5976872cef558a67653f863b512c47b31eda9cd53"
                }
              ],
              "appendInitialized": false
            }
          },
          "slots": [],
          "rounds": [
            {
              "roundIndex": 0,
              "status": "completed",
              "receipts": [
                {
                  "operationId": "cascade-r0-s0",
                  "kind": "generate",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "requestNodeId": "A",
                  "requestNodeDigest": "4dc30a0a5776b7938988d5d37466c679c0e5e431523f8de72a905b44a52c02fd",
                  "resultPolicy": "replace-with-history",
                  "status": "completed",
                  "childJobId": "a12049e7-3485-4a4f-a8e0-6cc01f217078",
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                      "kind": "image",
                      "name": "A.png",
                      "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                      "originalNodeId": "original-A",
                      "imageIndex": 0
                    }
                  ],
                  "fallbackRefs": [
                    {
                      "assetId": "793c1af5-a1ea-495e-a540-d4fea647b45a",
                      "kind": "image",
                      "name": "A.png",
                      "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                      "originalNodeId": "original-A",
                      "imageIndex": 0
                    }
                  ],
                  "outputRefs": [
                    {
                      "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8"
                    },
                    {
                      "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                      "kind": "image",
                      "name": "fixture-1-0.png",
                      "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79"
                    },
                    {
                      "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                      "kind": "image",
                      "name": "fixture-2-0.png",
                      "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd"
                    }
                  ]
                },
                {
                  "operationId": "cascade-r0-s1",
                  "kind": "copy",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "requestNodeId": null,
                  "requestNodeDigest": null,
                  "resultPolicy": "replace-with-history",
                  "status": "completed",
                  "childJobId": null,
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8",
                      "originalNodeId": "original-B",
                      "imageIndex": 0
                    },
                    {
                      "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                      "kind": "image",
                      "name": "fixture-1-0.png",
                      "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79",
                      "originalNodeId": "original-B",
                      "imageIndex": 1
                    },
                    {
                      "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                      "kind": "image",
                      "name": "fixture-2-0.png",
                      "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd",
                      "originalNodeId": "original-B",
                      "imageIndex": 2
                    }
                  ],
                  "fallbackRefs": [],
                  "outputRefs": [
                    {
                      "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8"
                    },
                    {
                      "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                      "kind": "image",
                      "name": "fixture-1-0.png",
                      "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79"
                    },
                    {
                      "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                      "kind": "image",
                      "name": "fixture-2-0.png",
                      "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd"
                    }
                  ]
                }
              ],
              "nodeOutputs": {
                "B": [
                  {
                    "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8"
                  },
                  {
                    "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79"
                  },
                  {
                    "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd"
                  }
                ],
                "C": [
                  {
                    "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8"
                  },
                  {
                    "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79"
                  },
                  {
                    "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd"
                  }
                ]
              },
              "operationOutputs": {
                "cascade-r0-s0": [
                  {
                    "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8",
                    "originalNodeId": "original-B",
                    "imageIndex": 0
                  },
                  {
                    "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79",
                    "originalNodeId": "original-B",
                    "imageIndex": 1
                  },
                  {
                    "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd",
                    "originalNodeId": "original-B",
                    "imageIndex": 2
                  }
                ],
                "cascade-r0-s1": [
                  {
                    "assetId": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "a2c4301decaf50d6938a86eb30f0df8c2cd4ceba43729b02f60004b0734a17a8",
                    "originalNodeId": "original-C",
                    "imageIndex": 0
                  },
                  {
                    "assetId": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "7d112ca9a1c6f43889627a47518418833bcd09990d0f0b9f46e0d9902adf6f79",
                    "originalNodeId": "original-C",
                    "imageIndex": 1
                  },
                  {
                    "assetId": "8f857870-1c99-45f1-8f39-72d8b946f595",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "941be8bf535e7e7c86e330736bf589e0cf3c953bd6cfc526220229ca04fe98fd",
                    "originalNodeId": "original-C",
                    "imageIndex": 2
                  }
                ]
              }
            }
          ]
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:60265",
          "network": "local"
        },
        "loopBackends": [
          {
            "id": "fixture-backend-0",
            "name": "本机合成后端0",
            "url": "http://127.0.0.1:60265",
            "network": "local"
          }
        ],
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:60265"
        }
      }
    ],
    "workflows": [
      {
        "id": "d4207520-dccf-4ef2-b78b-4b1738aeacbe",
        "name": "isolated cascade specialized",
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "未替换"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "未上传.png"
            }
          },
          "4": {
            "class_type": "KSampler",
            "inputs": {
              "seed": 30
            }
          }
        },
        "inspection": {
          "nodeCount": 4,
          "nodes": [
            {
              "id": "1",
              "class_type": "CLIPTextEncode",
              "title": null,
              "inputs": [
                {
                  "name": "text",
                  "type": "string",
                  "value": "未替换"
                }
              ]
            },
            {
              "id": "2",
              "class_type": "SaveImage",
              "title": null,
              "inputs": []
            },
            {
              "id": "3",
              "class_type": "LoadImage",
              "title": null,
              "inputs": [
                {
                  "name": "image",
                  "type": "string",
                  "value": "未上传.png"
                }
              ]
            },
            {
              "id": "4",
              "class_type": "KSampler",
              "title": null,
              "inputs": [
                {
                  "name": "seed",
                  "type": "number",
                  "value": 30
                }
              ]
            }
          ]
        },
        "revision": 2,
        "fields": [
          {
            "nodeId": "1",
            "name": "text",
            "control": "textarea",
            "label": "提示词",
            "help": "",
            "exposed": true,
            "nativeFieldId": "prompt",
            "defaultValue": "template literal"
          },
          {
            "nodeId": "3",
            "name": "image",
            "control": "text",
            "label": "参考图",
            "help": "",
            "exposed": true,
            "nativeFieldId": "image",
            "mediaKind": "image",
            "defaultValue": "original.png"
          },
          {
            "nodeId": "4",
            "name": "seed",
            "control": "number",
            "label": "seed",
            "help": "",
            "exposed": true,
            "min": 1,
            "max": 100,
            "randomEnabled": true,
            "defaultValue": 30
          }
        ],
        "createdAt": "2026-10-07T08:26:01.783Z",
        "updatedAt": "2026-10-07T08:26:01.789Z"
      },
      {
        "id": "d8347eea-1698-4abf-8a43-81cd328bbff8",
        "name": "本机合成输出",
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "未替换"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "未上传.png"
            }
          }
        },
        "inspection": {
          "nodeCount": 3,
          "nodes": [
            {
              "id": "1",
              "class_type": "CLIPTextEncode",
              "title": null,
              "inputs": [
                {
                  "name": "text",
                  "type": "string",
                  "value": "未替换"
                }
              ]
            },
            {
              "id": "2",
              "class_type": "SaveImage",
              "title": null,
              "inputs": []
            },
            {
              "id": "3",
              "class_type": "LoadImage",
              "title": null,
              "inputs": [
                {
                  "name": "image",
                  "type": "string",
                  "value": "未上传.png"
                }
              ]
            }
          ]
        },
        "revision": 0,
        "fields": [],
        "createdAt": "2026-10-07T08:26:01.771Z"
      }
    ],
    "assets": [
      {
        "meta": {
          "id": "16d52a66-72c6-4e1d-9309-81b6bd5c8b6f",
          "name": "fixture-0-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:26:01.857Z",
          "url": "/media/16d52a66-72c6-4e1d-9309-81b6bd5c8b6f"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "696d174d-95ba-4432-b569-f20c7ecc9fe4",
          "name": "fixture-1-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:26:01.902Z",
          "url": "/media/696d174d-95ba-4432-b569-f20c7ecc9fe4"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "8f857870-1c99-45f1-8f39-72d8b946f595",
          "name": "fixture-2-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:26:01.918Z",
          "url": "/media/8f857870-1c99-45f1-8f39-72d8b946f595"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "793c1af5-a1ea-495e-a540-d4fea647b45a",
          "name": "A.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:26:01.772Z",
          "url": "/media/793c1af5-a1ea-495e-a540-d4fea647b45a"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "b8d7f326-6db5-4c05-b5a0-472f82e9f94a",
          "name": "B.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:26:01.774Z",
          "url": "/media/b8d7f326-6db5-4c05-b5a0-472f82e9f94a"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "bb8b84f3-7da1-404c-9107-3d8c40a9a0e1",
          "name": "C.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:26:01.776Z",
          "url": "/media/bb8b84f3-7da1-404c-9107-3d8c40a9a0e1"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      }
    ]
  },
  {
    "scenario": "two-round-loop",
    "project": {
      "id": "cascade-project",
      "name": "智能串联规则样本",
      "revision": 0,
      "createdAt": "2026-10-07T08:33:47.344Z",
      "updatedAt": "2026-10-07T08:33:47.344Z",
      "nodes": [
        {
          "id": "A",
          "type": "image",
          "x": 0,
          "y": 0,
          "title": "A",
          "text": "",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-A",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-A",
                    "name": "A.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-A"
                },
                "promptDraftHtml": "",
                "promptDraftText": ""
              },
              "resources": [
                {
                  "url": "/api/assets/asset-A",
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "archive": "media/A.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "f7351c38-6553-4b7b-9152-3494a2939e5b"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
              "overrides": [],
              "imageSources": [],
              "promptBatch": {
                "nodeId": "1",
                "name": "text",
                "values": [
                  "第一条《计数》与 @原图",
                  "第二条 <literal>",
                  "第三条《总数》"
                ]
              },
              "incrementSeeds": true
            }
          }
        },
        {
          "id": "B",
          "type": "image",
          "x": 300,
          "y": 0,
          "title": "B",
          "text": "独立提示 B",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-B",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-B",
                    "name": "B.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-B"
                },
                "promptDraftHtml": "参数属于 B",
                "promptDraftText": "参数属于 B"
              },
              "resources": [
                {
                  "url": "/api/assets/asset-B",
                  "assetId": "a6661c35-053d-486b-a3cd-f0b301e959b3",
                  "archive": "media/B.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "a6661c35-053d-486b-a3cd-f0b301e959b3"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "a2c85851-87d1-49bf-9495-c16da74274f0",
              "count": 1,
              "overrides": [],
              "imageSources": [],
              "promptField": {
                "nodeId": "1",
                "name": "text"
              }
            }
          }
        },
        {
          "id": "C",
          "type": "image",
          "x": 600,
          "y": 0,
          "title": "C",
          "text": "独立提示 C",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-C",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-C",
                    "name": "C.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-C"
                },
                "promptDraftHtml": "参数属于 C",
                "promptDraftText": "参数属于 C"
              },
              "resources": [
                {
                  "url": "/api/assets/asset-C",
                  "assetId": "89a8010f-d94c-4f6f-b0ae-4b4804d189f2",
                  "archive": "media/C.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "89a8010f-d94c-4f6f-b0ae-4b4804d189f2"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "a2c85851-87d1-49bf-9495-c16da74274f0",
              "count": 1,
              "overrides": [],
              "imageSources": [],
              "promptField": {
                "nodeId": "1",
                "name": "text"
              }
            }
          }
        },
        {
          "id": "L",
          "type": "text",
          "x": 0,
          "y": 0,
          "title": "L",
          "text": "独立提示 L",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-L",
                "type": "smart-loop"
              },
              "resources": [],
              "missingResources": [],
              "mediaAssetIds": [],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "nativeLoop": {
              "version": 1,
              "enabled": true,
              "mode": "serial",
              "count": 2,
              "start": 4,
              "showPrompt": false,
              "imageInput": false,
              "imageBatchSize": 1,
              "videoInput": false,
              "videoBatchSize": 1,
              "variablePrompt": "第《计数》轮",
              "variablePrompts": null
            }
          }
        }
      ],
      "edges": [
        {
          "id": "edge-0",
          "source": "A",
          "target": "B",
          "nativeCanvasConnection": {
            "from": "original-A",
            "to": "original-B",
            "kind": "flow"
          }
        },
        {
          "id": "edge-1",
          "source": "A",
          "target": "C",
          "nativeCanvasConnection": {
            "from": "original-A",
            "to": "original-C",
            "kind": "flow"
          }
        },
        {
          "id": "edge-2",
          "source": "L",
          "target": "A",
          "nativeCanvasConnection": {
            "from": "original-L",
            "to": "original-A",
            "kind": "flow"
          }
        }
      ],
      "assets": [
        {
          "id": "f7351c38-6553-4b7b-9152-3494a2939e5b",
          "name": "A.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:33:47.344Z",
          "url": "/media/f7351c38-6553-4b7b-9152-3494a2939e5b"
        },
        {
          "id": "a6661c35-053d-486b-a3cd-f0b301e959b3",
          "name": "B.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:33:47.349Z",
          "url": "/media/a6661c35-053d-486b-a3cd-f0b301e959b3"
        },
        {
          "id": "89a8010f-d94c-4f6f-b0ae-4b4804d189f2",
          "name": "C.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:33:47.364Z",
          "url": "/media/89a8010f-d94c-4f6f-b0ae-4b4804d189f2"
        }
      ],
      "shots": [],
      "messages": [],
      "runs": [],
      "viewport": {
        "x": 0,
        "y": 0,
        "zoom": 1
      },
      "settings": {
        "ratio": "16:9",
        "fps": 24
      },
      "archived": false
    },
    "jobs": [
      {
        "id": "43f14bf9-4f70-49b3-bece-7cb1e8db8da0",
        "kind": "canvas-run",
        "executionMode": "native-cascade",
        "projectId": "cascade-project",
        "nodeId": "C",
        "requestId": "specialized-parent",
        "revision": 0,
        "name": "智能串联规则样本 · 智能串联",
        "createdAt": "2026-10-07T08:33:47.383Z",
        "status": "completed",
        "progress": 100,
        "message": "智能串联完成：6 份新素材，传递记录已保留，可检查后加入画布",
        "assets": [
          {
            "id": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
            "name": "fixture-0-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.458Z",
            "url": "/media/3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13"
          },
          {
            "id": "0a3fd25b-a972-436d-9c47-83f666b30c11",
            "name": "fixture-1-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.476Z",
            "url": "/media/0a3fd25b-a972-436d-9c47-83f666b30c11"
          },
          {
            "id": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
            "name": "fixture-2-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.491Z",
            "url": "/media/1b228a45-9b76-4449-a5e1-1390b6d00e12"
          },
          {
            "id": "585220eb-90f0-42f0-a43b-10687ecc22ab",
            "name": "fixture-3-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.552Z",
            "url": "/media/585220eb-90f0-42f0-a43b-10687ecc22ab"
          },
          {
            "id": "a63cc786-eeed-472e-ae21-a1dd3e786468",
            "name": "fixture-4-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.579Z",
            "url": "/media/a63cc786-eeed-472e-ae21-a1dd3e786468"
          },
          {
            "id": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
            "name": "fixture-5-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.602Z",
            "url": "/media/8997a6e9-0d96-4b83-b1aa-2c4cd3c92051"
          }
        ],
        "textResults": [],
        "steps": [
          {
            "executionId": "cascade-r0-s0",
            "nodeId": "A",
            "title": "A → B",
            "cascadeKind": "generate",
            "sourceNodeId": "A",
            "targetNodeId": "B",
            "count": 3,
            "status": "completed",
            "roundIndex": 0,
            "roundCount": 2,
            "loopId": "L",
            "loopTitle": "L",
            "nativeLoop": {
              "version": 1,
              "mode": "serial",
              "index": 4,
              "total": 5
            },
            "kind": "comfy",
            "text": "",
            "sendAssets": true,
            "promptBatch": {
              "nodeId": "1",
              "name": "text",
              "values": [
                "第一条《计数》与 @原图",
                "第二条 <literal>",
                "第三条《总数》"
              ]
            },
            "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
            "workflowRevision": 1,
            "actualInput": {
              "version": 1,
              "prompt": "",
              "displayPrompt": "",
              "roles": [
                {
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "kind": "image",
                  "role": "image_1"
                }
              ],
              "referenceRefs": [
                {
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "kind": "image",
                  "name": "A.png",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "mappings": [
                {
                  "nodeId": "3",
                  "name": "image",
                  "kind": "image",
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "unusedRefs": [],
              "promptFields": [],
              "providerRequestCount": 3,
              "promptBatch": {
                "nodeId": "1",
                "name": "text",
                "values": [
                  "第一条《计数》与 @原图",
                  "第二条 <literal>",
                  "第三条《总数》"
                ]
              },
              "batchExecution": {
                "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
                "workflowRevision": 1,
                "count": 3,
                "seedOffset": 0,
                "incrementSeeds": true,
                "randomFields": [],
                "imageBindings": [
                  {
                    "nodeId": "3",
                    "name": "image",
                    "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b"
                  }
                ],
                "mediaDefaults": [
                  {
                    "nodeId": "3",
                    "name": "image",
                    "value": "original.png"
                  }
                ],
                "workflowHash": "6ee391fc5df5e8fa12d93a5bb5429ca53d232aa7f4b9844e1019edae0dd34880"
              }
            },
            "jobId": "b35be7a5-07c3-420f-a815-1d7566f314e2",
            "childRequests": {
              "count": 3,
              "submitted": 3,
              "completed": 3,
              "items": [
                {
                  "index": 0,
                  "status": "completed",
                  "promptId": "fixture-0"
                },
                {
                  "index": 1,
                  "status": "completed",
                  "promptId": "fixture-1"
                },
                {
                  "index": 2,
                  "status": "completed",
                  "promptId": "fixture-2"
                }
              ]
            }
          },
          {
            "executionId": "cascade-r0-s1",
            "nodeId": "A",
            "title": "A → C",
            "cascadeKind": "copy",
            "sourceNodeId": "A",
            "targetNodeId": "C",
            "count": 0,
            "status": "completed",
            "roundIndex": 0,
            "roundCount": 2,
            "loopId": "L",
            "loopTitle": "L",
            "nativeLoop": {
              "version": 1,
              "mode": "serial",
              "index": 4,
              "total": 5
            },
            "kind": "cascade-copy"
          },
          {
            "executionId": "cascade-r1-s0",
            "nodeId": "A",
            "title": "A → B",
            "cascadeKind": "generate",
            "sourceNodeId": "A",
            "targetNodeId": "B",
            "count": 3,
            "status": "completed",
            "roundIndex": 1,
            "roundCount": 2,
            "loopId": "L",
            "loopTitle": "L",
            "nativeLoop": {
              "version": 1,
              "mode": "serial",
              "index": 5,
              "total": 5
            },
            "kind": "comfy",
            "text": "",
            "sendAssets": true,
            "promptBatch": {
              "nodeId": "1",
              "name": "text",
              "values": [
                "第一条《计数》与 @原图",
                "第二条 <literal>",
                "第三条《总数》"
              ]
            },
            "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
            "workflowRevision": 1,
            "actualInput": {
              "version": 1,
              "prompt": "",
              "displayPrompt": "",
              "roles": [
                {
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "kind": "image",
                  "role": "image_1"
                }
              ],
              "referenceRefs": [
                {
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "kind": "image",
                  "name": "A.png",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "mappings": [
                {
                  "nodeId": "3",
                  "name": "image",
                  "kind": "image",
                  "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "unusedRefs": [],
              "promptFields": [],
              "providerRequestCount": 3,
              "promptBatch": {
                "nodeId": "1",
                "name": "text",
                "values": [
                  "第一条《计数》与 @原图",
                  "第二条 <literal>",
                  "第三条《总数》"
                ]
              },
              "batchExecution": {
                "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
                "workflowRevision": 1,
                "count": 3,
                "seedOffset": 3,
                "incrementSeeds": true,
                "randomFields": [],
                "imageBindings": [
                  {
                    "nodeId": "3",
                    "name": "image",
                    "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b"
                  }
                ],
                "mediaDefaults": [
                  {
                    "nodeId": "3",
                    "name": "image",
                    "value": "original.png"
                  }
                ],
                "workflowHash": "e552cab3f5c6e1ae106b6120817bd91a6d33eca488cfac8a45e95ca080d45e69"
              }
            },
            "jobId": "8613b415-9e9f-41b4-abd8-9d794ffe200f",
            "childRequests": {
              "count": 3,
              "submitted": 3,
              "completed": 3,
              "items": [
                {
                  "index": 0,
                  "status": "completed",
                  "promptId": "fixture-3"
                },
                {
                  "index": 1,
                  "status": "completed",
                  "promptId": "fixture-4"
                },
                {
                  "index": 2,
                  "status": "completed",
                  "promptId": "fixture-5"
                }
              ]
            }
          },
          {
            "executionId": "cascade-r1-s1",
            "nodeId": "A",
            "title": "A → C",
            "cascadeKind": "copy",
            "sourceNodeId": "A",
            "targetNodeId": "C",
            "count": 0,
            "status": "completed",
            "roundIndex": 1,
            "roundCount": 2,
            "loopId": "L",
            "loopTitle": "L",
            "nativeLoop": {
              "version": 1,
              "mode": "serial",
              "index": 5,
              "total": 5
            },
            "kind": "cascade-copy"
          }
        ],
        "summary": {
          "operations": 4,
          "generations": 2,
          "requests": 6,
          "sharedCopies": 2,
          "relays": 0
        },
        "snapshot": {
          "id": "cascade-project",
          "name": "智能串联规则样本",
          "revision": 0,
          "createdAt": "2026-10-07T08:33:47.344Z",
          "updatedAt": "2026-10-07T08:33:47.344Z",
          "nodes": [
            {
              "id": "A",
              "type": "image",
              "x": 0,
              "y": 0,
              "title": "A",
              "text": "",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-A",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-A",
                        "name": "A.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-A"
                    },
                    "promptDraftHtml": "",
                    "promptDraftText": ""
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-A",
                      "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                      "archive": "media/A.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "f7351c38-6553-4b7b-9152-3494a2939e5b"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
                  "overrides": [],
                  "imageSources": [],
                  "promptBatch": {
                    "nodeId": "1",
                    "name": "text",
                    "values": [
                      "第一条《计数》与 @原图",
                      "第二条 <literal>",
                      "第三条《总数》"
                    ]
                  },
                  "incrementSeeds": true
                }
              }
            },
            {
              "id": "B",
              "type": "image",
              "x": 300,
              "y": 0,
              "title": "B",
              "text": "独立提示 B",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-B",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-B",
                        "name": "B.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-B"
                    },
                    "promptDraftHtml": "参数属于 B",
                    "promptDraftText": "参数属于 B"
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-B",
                      "assetId": "a6661c35-053d-486b-a3cd-f0b301e959b3",
                      "archive": "media/B.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "a6661c35-053d-486b-a3cd-f0b301e959b3"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "a2c85851-87d1-49bf-9495-c16da74274f0",
                  "count": 1,
                  "overrides": [],
                  "imageSources": [],
                  "promptField": {
                    "nodeId": "1",
                    "name": "text"
                  }
                }
              }
            },
            {
              "id": "C",
              "type": "image",
              "x": 600,
              "y": 0,
              "title": "C",
              "text": "独立提示 C",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-C",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-C",
                        "name": "C.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-C"
                    },
                    "promptDraftHtml": "参数属于 C",
                    "promptDraftText": "参数属于 C"
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-C",
                      "assetId": "89a8010f-d94c-4f6f-b0ae-4b4804d189f2",
                      "archive": "media/C.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "89a8010f-d94c-4f6f-b0ae-4b4804d189f2"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "a2c85851-87d1-49bf-9495-c16da74274f0",
                  "count": 1,
                  "overrides": [],
                  "imageSources": [],
                  "promptField": {
                    "nodeId": "1",
                    "name": "text"
                  }
                }
              }
            },
            {
              "id": "L",
              "type": "text",
              "x": 0,
              "y": 0,
              "title": "L",
              "text": "独立提示 L",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-L",
                    "type": "smart-loop"
                  },
                  "resources": [],
                  "missingResources": [],
                  "mediaAssetIds": [],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "nativeLoop": {
                  "version": 1,
                  "enabled": true,
                  "mode": "serial",
                  "count": 2,
                  "start": 4,
                  "showPrompt": false,
                  "imageInput": false,
                  "imageBatchSize": 1,
                  "videoInput": false,
                  "videoBatchSize": 1,
                  "variablePrompt": "第《计数》轮",
                  "variablePrompts": null
                }
              }
            }
          ],
          "edges": [
            {
              "id": "edge-0",
              "source": "A",
              "target": "B",
              "nativeCanvasConnection": {
                "from": "original-A",
                "to": "original-B",
                "kind": "flow"
              }
            },
            {
              "id": "edge-1",
              "source": "A",
              "target": "C",
              "nativeCanvasConnection": {
                "from": "original-A",
                "to": "original-C",
                "kind": "flow"
              }
            },
            {
              "id": "edge-2",
              "source": "L",
              "target": "A",
              "nativeCanvasConnection": {
                "from": "original-L",
                "to": "original-A",
                "kind": "flow"
              }
            }
          ],
          "assets": [
            {
              "id": "f7351c38-6553-4b7b-9152-3494a2939e5b",
              "name": "A.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:33:47.344Z",
              "url": "/media/f7351c38-6553-4b7b-9152-3494a2939e5b"
            },
            {
              "id": "a6661c35-053d-486b-a3cd-f0b301e959b3",
              "name": "B.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:33:47.349Z",
              "url": "/media/a6661c35-053d-486b-a3cd-f0b301e959b3"
            },
            {
              "id": "89a8010f-d94c-4f6f-b0ae-4b4804d189f2",
              "name": "C.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:33:47.364Z",
              "url": "/media/89a8010f-d94c-4f6f-b0ae-4b4804d189f2"
            }
          ],
          "shots": [],
          "messages": [],
          "runs": [],
          "viewport": {
            "x": 0,
            "y": 0,
            "zoom": 1
          },
          "settings": {
            "ratio": "16:9",
            "fps": 24
          },
          "archived": false
        },
        "cascadeProgram": {
          "version": 1,
          "mode": "native-cascade",
          "requestedNodeId": "C",
          "tailNodeId": "C",
          "rootNodeId": "A",
          "pathNodeIds": [
            "A",
            "C"
          ],
          "singleNodeLoopRun": false,
          "loop": {
            "nodeId": "L",
            "count": 2,
            "mode": "serial",
            "start": 4,
            "stride": 1,
            "endIndex": 5
          },
          "scheduling": {
            "mode": "serial",
            "parallelLimitPolicy": "comfy-backends-at-most-six"
          },
          "operationCount": 4,
          "generationOperationCount": 2,
          "rounds": [
            {
              "roundIndex": 0,
              "index": 4,
              "total": 5,
              "forceWorkflow": true,
              "loopContexts": {
                "L": {
                  "index": 4,
                  "total": 5
                }
              },
              "choices": [],
              "operations": [
                {
                  "id": "cascade-r0-s0",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "target": {
                    "kind": "node",
                    "nodeId": "B"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "generate",
                  "requestNodeId": "A",
                  "references": {
                    "kind": "self-default-incoming",
                    "selfNodeId": "A",
                    "defaultNodeId": "A",
                    "incoming": {
                      "kind": "default",
                      "nodeId": "A"
                    }
                  },
                  "resultPolicy": "append-loop",
                  "missingPromptFallback": {
                    "reference": {
                      "kind": "default",
                      "nodeId": "A"
                    },
                    "resultPolicy": "replace-with-history"
                  }
                },
                {
                  "id": "cascade-r0-s1",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "target": {
                    "kind": "node",
                    "nodeId": "C"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "copy",
                  "requestNodeId": null,
                  "references": {
                    "kind": "operation-output",
                    "operationId": "cascade-r0-s0"
                  },
                  "resultPolicy": "replace-with-history",
                  "missingPromptFallback": null
                }
              ],
              "skippedNodeIds": []
            },
            {
              "roundIndex": 1,
              "index": 5,
              "total": 5,
              "forceWorkflow": true,
              "loopContexts": {
                "L": {
                  "index": 5,
                  "total": 5
                }
              },
              "choices": [],
              "operations": [
                {
                  "id": "cascade-r1-s0",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "target": {
                    "kind": "node",
                    "nodeId": "B"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "generate",
                  "requestNodeId": "A",
                  "references": {
                    "kind": "self-default-incoming",
                    "selfNodeId": "A",
                    "defaultNodeId": "A",
                    "incoming": {
                      "kind": "default",
                      "nodeId": "A"
                    }
                  },
                  "resultPolicy": "append-loop",
                  "missingPromptFallback": {
                    "reference": {
                      "kind": "default",
                      "nodeId": "A"
                    },
                    "resultPolicy": "replace-with-history"
                  }
                },
                {
                  "id": "cascade-r1-s1",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "target": {
                    "kind": "node",
                    "nodeId": "C"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "copy",
                  "requestNodeId": null,
                  "references": {
                    "kind": "operation-output",
                    "operationId": "cascade-r1-s0"
                  },
                  "resultPolicy": "replace-with-history",
                  "missingPromptFallback": null
                }
              ],
              "skippedNodeIds": []
            }
          ]
        },
        "cascadeState": {
          "version": 1,
          "snapshotDigest": "9d8fb11aefedc69223859c86f8fa14b1b95ea5cd6ac11e2d35d36aaec12ada83",
          "programDigest": "9de160907e53f7040b172964285d99083cf02d61a273e3ebe6b943f81f0b6e07",
          "status": "completed",
          "completedOperationCount": 4,
          "completedOrder": [
            "0:cascade-r0-s0",
            "0:cascade-r0-s1",
            "1:cascade-r1-s0",
            "1:cascade-r1-s1"
          ],
          "receivers": {
            "B": {
              "currentRefs": [
                {
                  "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                  "kind": "image",
                  "name": "fixture-0-0.png",
                  "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00"
                },
                {
                  "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                  "kind": "image",
                  "name": "fixture-1-0.png",
                  "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d"
                },
                {
                  "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                  "kind": "image",
                  "name": "fixture-2-0.png",
                  "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f"
                },
                {
                  "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                  "kind": "image",
                  "name": "fixture-3-0.png",
                  "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7"
                },
                {
                  "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                  "kind": "image",
                  "name": "fixture-4-0.png",
                  "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7"
                },
                {
                  "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                  "kind": "image",
                  "name": "fixture-5-0.png",
                  "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45"
                }
              ],
              "historyRefs": [
                {
                  "assetId": "a6661c35-053d-486b-a3cd-f0b301e959b3",
                  "kind": "image",
                  "name": "B.png",
                  "identity": "bca08324d532859c52cb8814f61ddf2f010927987e1ea6d1ff8d90ad5fedb7f6"
                }
              ],
              "appendInitialized": true
            },
            "C": {
              "currentRefs": [
                {
                  "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                  "kind": "image",
                  "name": "fixture-3-0.png",
                  "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7"
                },
                {
                  "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                  "kind": "image",
                  "name": "fixture-4-0.png",
                  "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7"
                },
                {
                  "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                  "kind": "image",
                  "name": "fixture-5-0.png",
                  "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45"
                }
              ],
              "historyRefs": [
                {
                  "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                  "kind": "image",
                  "name": "fixture-0-0.png",
                  "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00"
                },
                {
                  "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                  "kind": "image",
                  "name": "fixture-1-0.png",
                  "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d"
                },
                {
                  "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                  "kind": "image",
                  "name": "fixture-2-0.png",
                  "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f"
                },
                {
                  "assetId": "89a8010f-d94c-4f6f-b0ae-4b4804d189f2",
                  "kind": "image",
                  "name": "C.png",
                  "identity": "15bbbe01d7a0a4a430658ac5976872cef558a67653f863b512c47b31eda9cd53"
                }
              ],
              "appendInitialized": false
            }
          },
          "slots": [],
          "rounds": [
            {
              "roundIndex": 0,
              "status": "completed",
              "receipts": [
                {
                  "operationId": "cascade-r0-s0",
                  "kind": "generate",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "requestNodeId": "A",
                  "requestNodeDigest": "4efc62ae84ae8f004fcc6a6324a781920fbcb6533d5c89b5a3b46ef26d6e1fc7",
                  "resultPolicy": "append-loop",
                  "status": "completed",
                  "childJobId": "b35be7a5-07c3-420f-a815-1d7566f314e2",
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                      "kind": "image",
                      "name": "A.png",
                      "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                      "originalNodeId": "original-A",
                      "imageIndex": 0
                    }
                  ],
                  "fallbackRefs": [],
                  "outputRefs": [
                    {
                      "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00"
                    },
                    {
                      "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                      "kind": "image",
                      "name": "fixture-1-0.png",
                      "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d"
                    },
                    {
                      "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                      "kind": "image",
                      "name": "fixture-2-0.png",
                      "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f"
                    }
                  ]
                },
                {
                  "operationId": "cascade-r0-s1",
                  "kind": "copy",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "requestNodeId": null,
                  "requestNodeDigest": null,
                  "resultPolicy": "replace-with-history",
                  "status": "completed",
                  "childJobId": null,
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00",
                      "originalNodeId": "original-B",
                      "imageIndex": 0
                    },
                    {
                      "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                      "kind": "image",
                      "name": "fixture-1-0.png",
                      "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d",
                      "originalNodeId": "original-B",
                      "imageIndex": 1
                    },
                    {
                      "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                      "kind": "image",
                      "name": "fixture-2-0.png",
                      "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f",
                      "originalNodeId": "original-B",
                      "imageIndex": 2
                    }
                  ],
                  "fallbackRefs": [],
                  "outputRefs": [
                    {
                      "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00"
                    },
                    {
                      "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                      "kind": "image",
                      "name": "fixture-1-0.png",
                      "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d"
                    },
                    {
                      "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                      "kind": "image",
                      "name": "fixture-2-0.png",
                      "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f"
                    }
                  ]
                }
              ],
              "nodeOutputs": {
                "B": [
                  {
                    "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00"
                  },
                  {
                    "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d"
                  },
                  {
                    "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f"
                  }
                ],
                "C": [
                  {
                    "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00"
                  },
                  {
                    "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d"
                  },
                  {
                    "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f"
                  }
                ]
              },
              "operationOutputs": {
                "cascade-r0-s0": [
                  {
                    "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00",
                    "originalNodeId": "original-B",
                    "imageIndex": 0
                  },
                  {
                    "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d",
                    "originalNodeId": "original-B",
                    "imageIndex": 1
                  },
                  {
                    "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f",
                    "originalNodeId": "original-B",
                    "imageIndex": 2
                  }
                ],
                "cascade-r0-s1": [
                  {
                    "assetId": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "01041a0ce6bc02a99852c366a0913d03ea4d9122d4465772696c6a2f84151f00",
                    "originalNodeId": "original-C",
                    "imageIndex": 0
                  },
                  {
                    "assetId": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                    "kind": "image",
                    "name": "fixture-1-0.png",
                    "identity": "0442e2786cd3830aed1e531d038b43ca75d45e4a1eef79e9c91741dd8cb02e3d",
                    "originalNodeId": "original-C",
                    "imageIndex": 1
                  },
                  {
                    "assetId": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                    "kind": "image",
                    "name": "fixture-2-0.png",
                    "identity": "d79e41cb4006f8134a0a7458bf2b8e045705b3691cf0924d5de83542a4e0731f",
                    "originalNodeId": "original-C",
                    "imageIndex": 2
                  }
                ]
              }
            },
            {
              "roundIndex": 1,
              "status": "completed",
              "receipts": [
                {
                  "operationId": "cascade-r1-s0",
                  "kind": "generate",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "requestNodeId": "A",
                  "requestNodeDigest": "4efc62ae84ae8f004fcc6a6324a781920fbcb6533d5c89b5a3b46ef26d6e1fc7",
                  "resultPolicy": "append-loop",
                  "status": "completed",
                  "childJobId": "8613b415-9e9f-41b4-abd8-9d794ffe200f",
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
                      "kind": "image",
                      "name": "A.png",
                      "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                      "originalNodeId": "original-A",
                      "imageIndex": 0
                    }
                  ],
                  "fallbackRefs": [],
                  "outputRefs": [
                    {
                      "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                      "kind": "image",
                      "name": "fixture-3-0.png",
                      "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7"
                    },
                    {
                      "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                      "kind": "image",
                      "name": "fixture-4-0.png",
                      "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7"
                    },
                    {
                      "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                      "kind": "image",
                      "name": "fixture-5-0.png",
                      "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45"
                    }
                  ]
                },
                {
                  "operationId": "cascade-r1-s1",
                  "kind": "copy",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "requestNodeId": null,
                  "requestNodeDigest": null,
                  "resultPolicy": "replace-with-history",
                  "status": "completed",
                  "childJobId": null,
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                      "kind": "image",
                      "name": "fixture-3-0.png",
                      "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7",
                      "originalNodeId": "original-B",
                      "imageIndex": 3
                    },
                    {
                      "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                      "kind": "image",
                      "name": "fixture-4-0.png",
                      "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7",
                      "originalNodeId": "original-B",
                      "imageIndex": 4
                    },
                    {
                      "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                      "kind": "image",
                      "name": "fixture-5-0.png",
                      "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45",
                      "originalNodeId": "original-B",
                      "imageIndex": 5
                    }
                  ],
                  "fallbackRefs": [],
                  "outputRefs": [
                    {
                      "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                      "kind": "image",
                      "name": "fixture-3-0.png",
                      "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7"
                    },
                    {
                      "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                      "kind": "image",
                      "name": "fixture-4-0.png",
                      "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7"
                    },
                    {
                      "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                      "kind": "image",
                      "name": "fixture-5-0.png",
                      "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45"
                    }
                  ]
                }
              ],
              "nodeOutputs": {
                "B": [
                  {
                    "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                    "kind": "image",
                    "name": "fixture-3-0.png",
                    "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7"
                  },
                  {
                    "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                    "kind": "image",
                    "name": "fixture-4-0.png",
                    "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7"
                  },
                  {
                    "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                    "kind": "image",
                    "name": "fixture-5-0.png",
                    "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45"
                  }
                ],
                "C": [
                  {
                    "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                    "kind": "image",
                    "name": "fixture-3-0.png",
                    "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7"
                  },
                  {
                    "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                    "kind": "image",
                    "name": "fixture-4-0.png",
                    "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7"
                  },
                  {
                    "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                    "kind": "image",
                    "name": "fixture-5-0.png",
                    "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45"
                  }
                ]
              },
              "operationOutputs": {
                "cascade-r1-s0": [
                  {
                    "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                    "kind": "image",
                    "name": "fixture-3-0.png",
                    "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7",
                    "originalNodeId": "original-B",
                    "imageIndex": 3
                  },
                  {
                    "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                    "kind": "image",
                    "name": "fixture-4-0.png",
                    "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7",
                    "originalNodeId": "original-B",
                    "imageIndex": 4
                  },
                  {
                    "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                    "kind": "image",
                    "name": "fixture-5-0.png",
                    "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45",
                    "originalNodeId": "original-B",
                    "imageIndex": 5
                  }
                ],
                "cascade-r1-s1": [
                  {
                    "assetId": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                    "kind": "image",
                    "name": "fixture-3-0.png",
                    "identity": "9b354a01cad78e13360987cc523c35fb27287f80e3cd9de8323e466433cde8c7",
                    "originalNodeId": "original-C",
                    "imageIndex": 0
                  },
                  {
                    "assetId": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                    "kind": "image",
                    "name": "fixture-4-0.png",
                    "identity": "fccca7a63413c0150b0de3b744882aa56c031a3170030a12da065ee16592c5b7",
                    "originalNodeId": "original-C",
                    "imageIndex": 1
                  },
                  {
                    "assetId": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                    "kind": "image",
                    "name": "fixture-5-0.png",
                    "identity": "081192ceb077193e335efcb6b9bc90acbb0cbd8fdcbc7783de60e75f4ead8c45",
                    "originalNodeId": "original-C",
                    "imageIndex": 2
                  }
                ]
              }
            }
          ]
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:62901",
          "network": "local"
        },
        "loopBackends": [
          {
            "id": "fixture-backend-0",
            "name": "本机合成后端0",
            "url": "http://127.0.0.1:62901",
            "network": "local"
          }
        ],
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:62901"
        }
      },
      {
        "id": "8613b415-9e9f-41b4-abd8-9d794ffe200f",
        "kind": "comfy",
        "projectId": "cascade-project",
        "parentId": "43f14bf9-4f70-49b3-bece-7cb1e8db8da0",
        "requestId": "cascade-child-8931ce0bc91d66de2c536627b34c685f755064cd237d10492c4c20389a121240",
        "revision": 0,
        "name": "isolated cascade specialized",
        "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:62901"
        },
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "template literal"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "fixture-reference.png"
            }
          },
          "4": {
            "class_type": "KSampler",
            "inputs": {
              "seed": 33
            }
          }
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:62901",
          "network": "local"
        },
        "count": 3,
        "promptBatch": {
          "nodeId": "1",
          "name": "text",
          "values": [
            "第一条《计数》与 @原图",
            "第二条 <literal>",
            "第三条《总数》"
          ]
        },
        "incrementSeeds": true,
        "target": {
          "id": "A",
          "assetId": null,
          "text": ""
        },
        "createdAt": "2026-10-07T08:33:47.525Z",
        "status": "completed",
        "progress": 100,
        "message": "已生成 3 份素材，可加入项目",
        "items": [
          {
            "index": 0,
            "status": "completed",
            "promptId": "fixture-3",
            "assets": [
              {
                "id": "585220eb-90f0-42f0-a43b-10687ecc22ab",
                "outputKey": "[\"2\",\"fixture-3-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第一条《计数》与 @原图"
          },
          {
            "index": 1,
            "status": "completed",
            "promptId": "fixture-4",
            "assets": [
              {
                "id": "a63cc786-eeed-472e-ae21-a1dd3e786468",
                "outputKey": "[\"2\",\"fixture-4-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第二条 <literal>"
          },
          {
            "index": 2,
            "status": "completed",
            "promptId": "fixture-5",
            "assets": [
              {
                "id": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
                "outputKey": "[\"2\",\"fixture-5-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第三条《总数》"
          }
        ],
        "assets": [
          {
            "id": "585220eb-90f0-42f0-a43b-10687ecc22ab",
            "name": "fixture-3-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.552Z",
            "url": "/media/585220eb-90f0-42f0-a43b-10687ecc22ab",
            "batchIndex": 0
          },
          {
            "id": "a63cc786-eeed-472e-ae21-a1dd3e786468",
            "name": "fixture-4-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.579Z",
            "url": "/media/a63cc786-eeed-472e-ae21-a1dd3e786468",
            "batchIndex": 1
          },
          {
            "id": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
            "name": "fixture-5-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.602Z",
            "url": "/media/8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
            "batchIndex": 2
          }
        ],
        "applied": false,
        "imageBindings": [
          {
            "nodeId": "3",
            "name": "image",
            "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b"
          }
        ],
        "inputMappings": [
          {
            "nodeId": "3",
            "name": "image",
            "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
            "uploaded": {
              "name": "fixture-reference.png",
              "subfolder": "",
              "type": "input"
            },
            "value": "fixture-reference.png"
          }
        ],
        "inputPrepared": true,
        "inputPreparation": "completed",
        "cascadeBatch": {
          "promptBatch": {
            "nodeId": "1",
            "name": "text",
            "values": [
              "第一条《计数》与 @原图",
              "第二条 <literal>",
              "第三条《总数》"
            ]
          },
          "batchExecution": {
            "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
            "workflowRevision": 1,
            "count": 3,
            "seedOffset": 3,
            "incrementSeeds": true,
            "randomFields": [],
            "imageBindings": [
              {
                "nodeId": "3",
                "name": "image",
                "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b"
              }
            ],
            "mediaDefaults": [
              {
                "nodeId": "3",
                "name": "image",
                "value": "original.png"
              }
            ],
            "workflowHash": "e552cab3f5c6e1ae106b6120817bd91a6d33eca488cfac8a45e95ca080d45e69"
          }
        }
      },
      {
        "id": "b35be7a5-07c3-420f-a815-1d7566f314e2",
        "kind": "comfy",
        "projectId": "cascade-project",
        "parentId": "43f14bf9-4f70-49b3-bece-7cb1e8db8da0",
        "requestId": "cascade-child-925f8e534a3856ddc0f55323045fe9bc99d2574925e7b0affe36afe8798eae99",
        "revision": 0,
        "name": "isolated cascade specialized",
        "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:62901"
        },
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "template literal"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "fixture-reference.png"
            }
          },
          "4": {
            "class_type": "KSampler",
            "inputs": {
              "seed": 30
            }
          }
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:62901",
          "network": "local"
        },
        "count": 3,
        "promptBatch": {
          "nodeId": "1",
          "name": "text",
          "values": [
            "第一条《计数》与 @原图",
            "第二条 <literal>",
            "第三条《总数》"
          ]
        },
        "incrementSeeds": true,
        "target": {
          "id": "A",
          "assetId": null,
          "text": ""
        },
        "createdAt": "2026-10-07T08:33:47.416Z",
        "status": "completed",
        "progress": 100,
        "message": "已生成 3 份素材，可加入项目",
        "items": [
          {
            "index": 0,
            "status": "completed",
            "promptId": "fixture-0",
            "assets": [
              {
                "id": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
                "outputKey": "[\"2\",\"fixture-0-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第一条《计数》与 @原图"
          },
          {
            "index": 1,
            "status": "completed",
            "promptId": "fixture-1",
            "assets": [
              {
                "id": "0a3fd25b-a972-436d-9c47-83f666b30c11",
                "outputKey": "[\"2\",\"fixture-1-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第二条 <literal>"
          },
          {
            "index": 2,
            "status": "completed",
            "promptId": "fixture-2",
            "assets": [
              {
                "id": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
                "outputKey": "[\"2\",\"fixture-2-0.png\",\"\",\"output\"]"
              }
            ],
            "prompt": "第三条《总数》"
          }
        ],
        "assets": [
          {
            "id": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
            "name": "fixture-0-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.458Z",
            "url": "/media/3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
            "batchIndex": 0
          },
          {
            "id": "0a3fd25b-a972-436d-9c47-83f666b30c11",
            "name": "fixture-1-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.476Z",
            "url": "/media/0a3fd25b-a972-436d-9c47-83f666b30c11",
            "batchIndex": 1
          },
          {
            "id": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
            "name": "fixture-2-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:33:47.491Z",
            "url": "/media/1b228a45-9b76-4449-a5e1-1390b6d00e12",
            "batchIndex": 2
          }
        ],
        "applied": false,
        "imageBindings": [
          {
            "nodeId": "3",
            "name": "image",
            "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b"
          }
        ],
        "inputMappings": [
          {
            "nodeId": "3",
            "name": "image",
            "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b",
            "uploaded": {
              "name": "fixture-reference.png",
              "subfolder": "",
              "type": "input"
            },
            "value": "fixture-reference.png"
          }
        ],
        "inputPrepared": true,
        "inputPreparation": "completed",
        "cascadeBatch": {
          "promptBatch": {
            "nodeId": "1",
            "name": "text",
            "values": [
              "第一条《计数》与 @原图",
              "第二条 <literal>",
              "第三条《总数》"
            ]
          },
          "batchExecution": {
            "workflowId": "f6027236-f6bd-4562-ad84-55882573f163",
            "workflowRevision": 1,
            "count": 3,
            "seedOffset": 0,
            "incrementSeeds": true,
            "randomFields": [],
            "imageBindings": [
              {
                "nodeId": "3",
                "name": "image",
                "assetId": "f7351c38-6553-4b7b-9152-3494a2939e5b"
              }
            ],
            "mediaDefaults": [
              {
                "nodeId": "3",
                "name": "image",
                "value": "original.png"
              }
            ],
            "workflowHash": "6ee391fc5df5e8fa12d93a5bb5429ca53d232aa7f4b9844e1019edae0dd34880"
          }
        }
      }
    ],
    "workflows": [
      {
        "id": "a2c85851-87d1-49bf-9495-c16da74274f0",
        "name": "本机合成输出",
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "未替换"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "未上传.png"
            }
          }
        },
        "inspection": {
          "nodeCount": 3,
          "nodes": [
            {
              "id": "1",
              "class_type": "CLIPTextEncode",
              "title": null,
              "inputs": [
                {
                  "name": "text",
                  "type": "string",
                  "value": "未替换"
                }
              ]
            },
            {
              "id": "2",
              "class_type": "SaveImage",
              "title": null,
              "inputs": []
            },
            {
              "id": "3",
              "class_type": "LoadImage",
              "title": null,
              "inputs": [
                {
                  "name": "image",
                  "type": "string",
                  "value": "未上传.png"
                }
              ]
            }
          ]
        },
        "revision": 0,
        "fields": [],
        "createdAt": "2026-10-07T08:33:47.343Z"
      },
      {
        "id": "f6027236-f6bd-4562-ad84-55882573f163",
        "name": "isolated cascade specialized",
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "未替换"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "未上传.png"
            }
          },
          "4": {
            "class_type": "KSampler",
            "inputs": {
              "seed": 30
            }
          }
        },
        "inspection": {
          "nodeCount": 4,
          "nodes": [
            {
              "id": "1",
              "class_type": "CLIPTextEncode",
              "title": null,
              "inputs": [
                {
                  "name": "text",
                  "type": "string",
                  "value": "未替换"
                }
              ]
            },
            {
              "id": "2",
              "class_type": "SaveImage",
              "title": null,
              "inputs": []
            },
            {
              "id": "3",
              "class_type": "LoadImage",
              "title": null,
              "inputs": [
                {
                  "name": "image",
                  "type": "string",
                  "value": "未上传.png"
                }
              ]
            },
            {
              "id": "4",
              "class_type": "KSampler",
              "title": null,
              "inputs": [
                {
                  "name": "seed",
                  "type": "number",
                  "value": 30
                }
              ]
            }
          ]
        },
        "revision": 1,
        "fields": [
          {
            "nodeId": "1",
            "name": "text",
            "control": "textarea",
            "label": "提示词",
            "help": "",
            "exposed": true,
            "nativeFieldId": "prompt",
            "defaultValue": "template literal"
          },
          {
            "nodeId": "3",
            "name": "image",
            "control": "text",
            "label": "参考图",
            "help": "",
            "exposed": true,
            "nativeFieldId": "image",
            "mediaKind": "image",
            "defaultValue": "original.png"
          },
          {
            "nodeId": "4",
            "name": "seed",
            "control": "number",
            "label": "seed",
            "help": "",
            "exposed": false,
            "defaultValue": 30
          }
        ],
        "createdAt": "2026-10-07T08:33:47.368Z",
        "updatedAt": "2026-10-07T08:33:47.370Z"
      }
    ],
    "assets": [
      {
        "meta": {
          "id": "3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13",
          "name": "fixture-0-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:33:47.458Z",
          "url": "/media/3ade4a2d-11c9-4112-9ab8-b38ab4f6ac13"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "0a3fd25b-a972-436d-9c47-83f666b30c11",
          "name": "fixture-1-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:33:47.476Z",
          "url": "/media/0a3fd25b-a972-436d-9c47-83f666b30c11"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "1b228a45-9b76-4449-a5e1-1390b6d00e12",
          "name": "fixture-2-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:33:47.491Z",
          "url": "/media/1b228a45-9b76-4449-a5e1-1390b6d00e12"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "585220eb-90f0-42f0-a43b-10687ecc22ab",
          "name": "fixture-3-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:33:47.552Z",
          "url": "/media/585220eb-90f0-42f0-a43b-10687ecc22ab"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "a63cc786-eeed-472e-ae21-a1dd3e786468",
          "name": "fixture-4-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:33:47.579Z",
          "url": "/media/a63cc786-eeed-472e-ae21-a1dd3e786468"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "8997a6e9-0d96-4b83-b1aa-2c4cd3c92051",
          "name": "fixture-5-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:33:47.602Z",
          "url": "/media/8997a6e9-0d96-4b83-b1aa-2c4cd3c92051"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "f7351c38-6553-4b7b-9152-3494a2939e5b",
          "name": "A.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:33:47.344Z",
          "url": "/media/f7351c38-6553-4b7b-9152-3494a2939e5b"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "a6661c35-053d-486b-a3cd-f0b301e959b3",
          "name": "B.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:33:47.349Z",
          "url": "/media/a6661c35-053d-486b-a3cd-f0b301e959b3"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "89a8010f-d94c-4f6f-b0ae-4b4804d189f2",
          "name": "C.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:33:47.364Z",
          "url": "/media/89a8010f-d94c-4f6f-b0ae-4b4804d189f2"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      }
    ]
  },
  {
    "scenario": "upscale",
    "project": {
      "id": "cascade-project",
      "name": "智能串联规则样本",
      "revision": 0,
      "createdAt": "2026-10-07T08:34:05.274Z",
      "updatedAt": "2026-10-07T08:34:05.274Z",
      "nodes": [
        {
          "id": "A",
          "type": "image",
          "x": 0,
          "y": 0,
          "title": "A",
          "text": "",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-A",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-A",
                    "name": "A.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-A"
                },
                "promptDraftHtml": "",
                "promptDraftText": ""
              },
              "resources": [
                {
                  "url": "/api/assets/asset-A",
                  "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                  "archive": "media/A.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "e149bcb3-bd98-4b71-9fd9-0106d70200ca"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
              "overrides": [],
              "imageSources": [
                {
                  "nodeId": "15",
                  "name": "image",
                  "sourceNodeId": "A"
                }
              ],
              "imageEnhance": {
                "kind": "upscale",
                "engine": "comfy",
                "imageField": {
                  "nodeId": "15",
                  "name": "image"
                },
                "resolution": 4096,
                "maxResolution": 4096,
                "resolutionField": {
                  "nodeId": "172",
                  "name": "resolution"
                },
                "maxResolutionField": {
                  "nodeId": "172",
                  "name": "max_resolution"
                },
                "seedMode": "fixed",
                "seed": 5678,
                "seedFields": [
                  {
                    "nodeId": "172",
                    "name": "seed"
                  }
                ]
              },
              "count": 1,
              "incrementSeeds": false
            }
          }
        },
        {
          "id": "B",
          "type": "image",
          "x": 300,
          "y": 0,
          "title": "B",
          "text": "独立提示 B",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-B",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-B",
                    "name": "B.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-B"
                },
                "promptDraftHtml": "参数属于 B",
                "promptDraftText": "参数属于 B"
              },
              "resources": [
                {
                  "url": "/api/assets/asset-B",
                  "assetId": "7d2c9789-1381-4807-bdbd-1314b8a67ed9",
                  "archive": "media/B.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "7d2c9789-1381-4807-bdbd-1314b8a67ed9"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "f9ca8b47-fdf8-4108-b57f-d9daf33bfa27",
              "count": 1,
              "overrides": [],
              "imageSources": [],
              "promptField": {
                "nodeId": "1",
                "name": "text"
              }
            }
          }
        },
        {
          "id": "C",
          "type": "image",
          "x": 600,
          "y": 0,
          "title": "C",
          "text": "独立提示 C",
          "assetId": null,
          "params": {
            "nativeCanvas": {
              "version": 1,
              "format": "infinite-smart-canvas-workflow",
              "adaptation": "reference",
              "node": {
                "id": "original-C",
                "type": "smart-image",
                "images": [
                  {
                    "url": "/api/assets/asset-C",
                    "name": "C.png",
                    "kind": "image"
                  }
                ],
                "runSettings": {
                  "engine": "comfy",
                  "comfyWorkflow": "wf-C"
                },
                "promptDraftHtml": "参数属于 C",
                "promptDraftText": "参数属于 C"
              },
              "resources": [
                {
                  "url": "/api/assets/asset-C",
                  "assetId": "bfe13afd-4cb2-4900-98dc-047a9bfcef30",
                  "archive": "media/C.png"
                }
              ],
              "missingResources": [],
              "mediaAssetIds": [
                "bfe13afd-4cb2-4900-98dc-047a9bfcef30"
              ],
              "members": [],
              "inputOrder": [],
              "outgoingMedia": false,
              "connectedOutput": false,
              "connectedGroup": false
            },
            "workflowBinding": {
              "workflowId": "f9ca8b47-fdf8-4108-b57f-d9daf33bfa27",
              "count": 1,
              "overrides": [],
              "imageSources": [],
              "promptField": {
                "nodeId": "1",
                "name": "text"
              }
            }
          }
        }
      ],
      "edges": [
        {
          "id": "edge-0",
          "source": "A",
          "target": "B",
          "nativeCanvasConnection": {
            "from": "original-A",
            "to": "original-B",
            "kind": "flow"
          }
        },
        {
          "id": "edge-1",
          "source": "A",
          "target": "C",
          "nativeCanvasConnection": {
            "from": "original-A",
            "to": "original-C",
            "kind": "flow"
          }
        }
      ],
      "assets": [
        {
          "id": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
          "name": "A.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:34:05.275Z",
          "url": "/media/e149bcb3-bd98-4b71-9fd9-0106d70200ca"
        },
        {
          "id": "7d2c9789-1381-4807-bdbd-1314b8a67ed9",
          "name": "B.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:34:05.278Z",
          "url": "/media/7d2c9789-1381-4807-bdbd-1314b8a67ed9"
        },
        {
          "id": "bfe13afd-4cb2-4900-98dc-047a9bfcef30",
          "name": "C.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:34:05.279Z",
          "url": "/media/bfe13afd-4cb2-4900-98dc-047a9bfcef30"
        }
      ],
      "shots": [],
      "messages": [],
      "runs": [],
      "viewport": {
        "x": 0,
        "y": 0,
        "zoom": 1
      },
      "settings": {
        "ratio": "16:9",
        "fps": 24
      },
      "archived": false
    },
    "jobs": [
      {
        "id": "6df03037-0129-4240-a8e4-6b3a96265a96",
        "kind": "canvas-run",
        "executionMode": "native-cascade",
        "projectId": "cascade-project",
        "nodeId": "C",
        "requestId": "specialized-parent",
        "revision": 0,
        "name": "智能串联规则样本 · 智能串联",
        "createdAt": "2026-10-07T08:34:05.287Z",
        "status": "completed",
        "progress": 100,
        "message": "智能串联完成：1 份新素材，传递记录已保留，可检查后加入画布",
        "assets": [
          {
            "id": "7beb75ae-805d-4525-a12f-21620868832c",
            "name": "fixture-0-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:34:05.339Z",
            "url": "/media/7beb75ae-805d-4525-a12f-21620868832c",
            "enhancement": {
              "kind": "upscale",
              "engine": "comfy",
              "sourceAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
              "originalAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
              "resolution": 4096,
              "maxResolution": 4096,
              "seed": 5678
            }
          }
        ],
        "textResults": [],
        "steps": [
          {
            "executionId": "cascade-r0-s0",
            "nodeId": "A",
            "title": "A → B",
            "cascadeKind": "generate",
            "sourceNodeId": "A",
            "targetNodeId": "B",
            "count": 1,
            "status": "completed",
            "roundIndex": 0,
            "roundCount": 1,
            "kind": "comfy",
            "text": "",
            "sendAssets": true,
            "imageEnhance": {
              "kind": "upscale",
              "engine": "comfy",
              "imageField": {
                "nodeId": "15",
                "name": "image"
              },
              "resolution": 4096,
              "maxResolution": 4096,
              "resolutionField": {
                "nodeId": "172",
                "name": "resolution"
              },
              "maxResolutionField": {
                "nodeId": "172",
                "name": "max_resolution"
              },
              "seedMode": "fixed",
              "seedFields": [
                {
                  "nodeId": "172",
                  "name": "seed"
                }
              ],
              "seed": 5678
            },
            "workflowId": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
            "workflowRevision": 0,
            "actualInput": {
              "version": 1,
              "prompt": "",
              "displayPrompt": "",
              "roles": [
                {
                  "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                  "kind": "image",
                  "role": "image_1"
                }
              ],
              "referenceRefs": [
                {
                  "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                  "kind": "image",
                  "name": "A.png",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "mappings": [
                {
                  "nodeId": "15",
                  "name": "image",
                  "kind": "image",
                  "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                  "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669"
                }
              ],
              "unusedRefs": [],
              "promptFields": [],
              "providerRequestCount": 1,
              "enhancement": {
                "kind": "upscale",
                "engine": "comfy",
                "resolution": 4096,
                "maxResolution": 4096,
                "seedMode": "fixed",
                "sourceAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                "sourceIdentity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                "workflowId": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
                "workflowRevision": 0,
                "seed": 5678
              }
            },
            "jobId": "835c3c90-0807-414a-802f-dafffd110eb0"
          },
          {
            "executionId": "cascade-r0-s1",
            "nodeId": "A",
            "title": "A → C",
            "cascadeKind": "copy",
            "sourceNodeId": "A",
            "targetNodeId": "C",
            "count": 0,
            "status": "completed",
            "roundIndex": 0,
            "roundCount": 1,
            "kind": "cascade-copy"
          }
        ],
        "summary": {
          "operations": 2,
          "generations": 1,
          "requests": 1,
          "sharedCopies": 1,
          "relays": 0
        },
        "snapshot": {
          "id": "cascade-project",
          "name": "智能串联规则样本",
          "revision": 0,
          "createdAt": "2026-10-07T08:34:05.274Z",
          "updatedAt": "2026-10-07T08:34:05.274Z",
          "nodes": [
            {
              "id": "A",
              "type": "image",
              "x": 0,
              "y": 0,
              "title": "A",
              "text": "",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-A",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-A",
                        "name": "A.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-A"
                    },
                    "promptDraftHtml": "",
                    "promptDraftText": ""
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-A",
                      "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                      "archive": "media/A.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "e149bcb3-bd98-4b71-9fd9-0106d70200ca"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
                  "overrides": [],
                  "imageSources": [
                    {
                      "nodeId": "15",
                      "name": "image",
                      "sourceNodeId": "A"
                    }
                  ],
                  "imageEnhance": {
                    "kind": "upscale",
                    "engine": "comfy",
                    "imageField": {
                      "nodeId": "15",
                      "name": "image"
                    },
                    "resolution": 4096,
                    "maxResolution": 4096,
                    "resolutionField": {
                      "nodeId": "172",
                      "name": "resolution"
                    },
                    "maxResolutionField": {
                      "nodeId": "172",
                      "name": "max_resolution"
                    },
                    "seedMode": "fixed",
                    "seed": 5678,
                    "seedFields": [
                      {
                        "nodeId": "172",
                        "name": "seed"
                      }
                    ]
                  },
                  "count": 1,
                  "incrementSeeds": false
                }
              }
            },
            {
              "id": "B",
              "type": "image",
              "x": 300,
              "y": 0,
              "title": "B",
              "text": "独立提示 B",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-B",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-B",
                        "name": "B.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-B"
                    },
                    "promptDraftHtml": "参数属于 B",
                    "promptDraftText": "参数属于 B"
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-B",
                      "assetId": "7d2c9789-1381-4807-bdbd-1314b8a67ed9",
                      "archive": "media/B.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "7d2c9789-1381-4807-bdbd-1314b8a67ed9"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "f9ca8b47-fdf8-4108-b57f-d9daf33bfa27",
                  "count": 1,
                  "overrides": [],
                  "imageSources": [],
                  "promptField": {
                    "nodeId": "1",
                    "name": "text"
                  }
                }
              }
            },
            {
              "id": "C",
              "type": "image",
              "x": 600,
              "y": 0,
              "title": "C",
              "text": "独立提示 C",
              "assetId": null,
              "params": {
                "nativeCanvas": {
                  "version": 1,
                  "format": "infinite-smart-canvas-workflow",
                  "adaptation": "reference",
                  "node": {
                    "id": "original-C",
                    "type": "smart-image",
                    "images": [
                      {
                        "url": "/api/assets/asset-C",
                        "name": "C.png",
                        "kind": "image"
                      }
                    ],
                    "runSettings": {
                      "engine": "comfy",
                      "comfyWorkflow": "wf-C"
                    },
                    "promptDraftHtml": "参数属于 C",
                    "promptDraftText": "参数属于 C"
                  },
                  "resources": [
                    {
                      "url": "/api/assets/asset-C",
                      "assetId": "bfe13afd-4cb2-4900-98dc-047a9bfcef30",
                      "archive": "media/C.png"
                    }
                  ],
                  "missingResources": [],
                  "mediaAssetIds": [
                    "bfe13afd-4cb2-4900-98dc-047a9bfcef30"
                  ],
                  "members": [],
                  "inputOrder": [],
                  "outgoingMedia": false,
                  "connectedOutput": false,
                  "connectedGroup": false
                },
                "workflowBinding": {
                  "workflowId": "f9ca8b47-fdf8-4108-b57f-d9daf33bfa27",
                  "count": 1,
                  "overrides": [],
                  "imageSources": [],
                  "promptField": {
                    "nodeId": "1",
                    "name": "text"
                  }
                }
              }
            }
          ],
          "edges": [
            {
              "id": "edge-0",
              "source": "A",
              "target": "B",
              "nativeCanvasConnection": {
                "from": "original-A",
                "to": "original-B",
                "kind": "flow"
              }
            },
            {
              "id": "edge-1",
              "source": "A",
              "target": "C",
              "nativeCanvasConnection": {
                "from": "original-A",
                "to": "original-C",
                "kind": "flow"
              }
            }
          ],
          "assets": [
            {
              "id": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
              "name": "A.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:34:05.275Z",
              "url": "/media/e149bcb3-bd98-4b71-9fd9-0106d70200ca"
            },
            {
              "id": "7d2c9789-1381-4807-bdbd-1314b8a67ed9",
              "name": "B.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:34:05.278Z",
              "url": "/media/7d2c9789-1381-4807-bdbd-1314b8a67ed9"
            },
            {
              "id": "bfe13afd-4cb2-4900-98dc-047a9bfcef30",
              "name": "C.png",
              "type": "image/png",
              "size": 68,
              "category": "",
              "tags": [],
              "source": "import",
              "createdAt": "2026-10-07T08:34:05.279Z",
              "url": "/media/bfe13afd-4cb2-4900-98dc-047a9bfcef30"
            }
          ],
          "shots": [],
          "messages": [],
          "runs": [],
          "viewport": {
            "x": 0,
            "y": 0,
            "zoom": 1
          },
          "settings": {
            "ratio": "16:9",
            "fps": 24
          },
          "archived": false
        },
        "cascadeProgram": {
          "version": 1,
          "mode": "native-cascade",
          "requestedNodeId": "C",
          "tailNodeId": "C",
          "rootNodeId": "A",
          "pathNodeIds": [
            "A",
            "C"
          ],
          "singleNodeLoopRun": false,
          "loop": null,
          "scheduling": {
            "mode": "serial",
            "parallelLimitPolicy": "comfy-backends-at-most-six"
          },
          "operationCount": 2,
          "generationOperationCount": 1,
          "rounds": [
            {
              "roundIndex": 0,
              "index": null,
              "total": null,
              "forceWorkflow": false,
              "loopContexts": {},
              "choices": [],
              "operations": [
                {
                  "id": "cascade-r0-s0",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "target": {
                    "kind": "node",
                    "nodeId": "B"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "generate",
                  "requestNodeId": "A",
                  "references": {
                    "kind": "self-default-incoming",
                    "selfNodeId": "A",
                    "defaultNodeId": "A",
                    "incoming": {
                      "kind": "default",
                      "nodeId": "A"
                    }
                  },
                  "resultPolicy": "replace-with-history",
                  "missingPromptFallback": {
                    "reference": {
                      "kind": "default",
                      "nodeId": "A"
                    },
                    "resultPolicy": "replace-with-history"
                  }
                },
                {
                  "id": "cascade-r0-s1",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "target": {
                    "kind": "node",
                    "nodeId": "C"
                  },
                  "relayPromptNodeIds": [],
                  "preserveTargetConfiguration": true,
                  "kind": "copy",
                  "requestNodeId": null,
                  "references": {
                    "kind": "operation-output",
                    "operationId": "cascade-r0-s0"
                  },
                  "resultPolicy": "replace-with-history",
                  "missingPromptFallback": null
                }
              ],
              "skippedNodeIds": []
            }
          ]
        },
        "cascadeState": {
          "version": 1,
          "snapshotDigest": "3d9d884d9d842e11440f7a0413fac1ffa1f705df3853537340e34d76bc7abdac",
          "programDigest": "14a800e2da3660ab67f9d6b9a15d72f67dbc1d594d6ab04ea1b6ea277fe6ff7b",
          "status": "completed",
          "completedOperationCount": 2,
          "completedOrder": [
            "0:cascade-r0-s0",
            "0:cascade-r0-s1"
          ],
          "receivers": {
            "B": {
              "currentRefs": [
                {
                  "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                  "kind": "image",
                  "name": "fixture-0-0.png",
                  "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd"
                }
              ],
              "historyRefs": [
                {
                  "assetId": "7d2c9789-1381-4807-bdbd-1314b8a67ed9",
                  "kind": "image",
                  "name": "B.png",
                  "identity": "bca08324d532859c52cb8814f61ddf2f010927987e1ea6d1ff8d90ad5fedb7f6"
                }
              ],
              "appendInitialized": false
            },
            "C": {
              "currentRefs": [
                {
                  "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                  "kind": "image",
                  "name": "fixture-0-0.png",
                  "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd"
                }
              ],
              "historyRefs": [
                {
                  "assetId": "bfe13afd-4cb2-4900-98dc-047a9bfcef30",
                  "kind": "image",
                  "name": "C.png",
                  "identity": "15bbbe01d7a0a4a430658ac5976872cef558a67653f863b512c47b31eda9cd53"
                }
              ],
              "appendInitialized": false
            }
          },
          "slots": [],
          "rounds": [
            {
              "roundIndex": 0,
              "status": "completed",
              "receipts": [
                {
                  "operationId": "cascade-r0-s0",
                  "kind": "generate",
                  "sourceNodeId": "A",
                  "targetNodeId": "B",
                  "requestNodeId": "A",
                  "requestNodeDigest": "98a5814137f27436f524f4129f53209ad7dce63c6afd006b46268429bc8f98fc",
                  "resultPolicy": "replace-with-history",
                  "status": "completed",
                  "childJobId": "835c3c90-0807-414a-802f-dafffd110eb0",
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                      "kind": "image",
                      "name": "A.png",
                      "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                      "originalNodeId": "original-A",
                      "imageIndex": 0
                    }
                  ],
                  "fallbackRefs": [
                    {
                      "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
                      "kind": "image",
                      "name": "A.png",
                      "identity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
                      "originalNodeId": "original-A",
                      "imageIndex": 0
                    }
                  ],
                  "outputRefs": [
                    {
                      "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd"
                    }
                  ]
                },
                {
                  "operationId": "cascade-r0-s1",
                  "kind": "copy",
                  "sourceNodeId": "A",
                  "targetNodeId": "C",
                  "requestNodeId": null,
                  "requestNodeDigest": null,
                  "resultPolicy": "replace-with-history",
                  "status": "completed",
                  "childJobId": null,
                  "usedFallback": false,
                  "inputRefs": [
                    {
                      "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd",
                      "originalNodeId": "original-B",
                      "imageIndex": 0
                    }
                  ],
                  "fallbackRefs": [],
                  "outputRefs": [
                    {
                      "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                      "kind": "image",
                      "name": "fixture-0-0.png",
                      "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd"
                    }
                  ]
                }
              ],
              "nodeOutputs": {
                "B": [
                  {
                    "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd"
                  }
                ],
                "C": [
                  {
                    "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd"
                  }
                ]
              },
              "operationOutputs": {
                "cascade-r0-s0": [
                  {
                    "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd",
                    "originalNodeId": "original-B",
                    "imageIndex": 0
                  }
                ],
                "cascade-r0-s1": [
                  {
                    "assetId": "7beb75ae-805d-4525-a12f-21620868832c",
                    "kind": "image",
                    "name": "fixture-0-0.png",
                    "identity": "fe1992d19afbf0a493f033d1f4140c4d4e2088ff2b8bf9abdef754b80ea87bbd",
                    "originalNodeId": "original-C",
                    "imageIndex": 0
                  }
                ]
              }
            }
          ]
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:63247",
          "network": "local"
        },
        "loopBackends": [
          {
            "id": "fixture-backend-0",
            "name": "本机合成后端0",
            "url": "http://127.0.0.1:63247",
            "network": "local"
          }
        ],
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:63247"
        }
      },
      {
        "id": "835c3c90-0807-414a-802f-dafffd110eb0",
        "kind": "comfy",
        "projectId": "cascade-project",
        "parentId": "6df03037-0129-4240-a8e4-6b3a96265a96",
        "requestId": "cascade-child-8d7bb16f6b1d62fc84d6e7c12ae8ccd3970840a8e165ce9cf5a07e4dcf2f8130",
        "revision": 0,
        "name": "isolated cascade specialized",
        "workflowId": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
        "backend": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:63247"
        },
        "workflow": {
          "15": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "fixture-reference.png"
            }
          },
          "172": {
            "class_type": "SeedVR2VideoUpscaler",
            "inputs": {
              "seed": 5678,
              "resolution": 4096,
              "max_resolution": 4096,
              "image": [
                "15",
                0
              ]
            }
          },
          "174": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "172",
                0
              ],
              "filename_prefix": "upscale"
            }
          }
        },
        "endpoint": {
          "id": "fixture-backend-0",
          "name": "本机合成后端0",
          "url": "http://127.0.0.1:63247",
          "network": "local"
        },
        "count": 1,
        "incrementSeeds": false,
        "target": {
          "id": "A",
          "assetId": null,
          "text": ""
        },
        "createdAt": "2026-10-07T08:34:05.313Z",
        "status": "completed",
        "progress": 100,
        "message": "已生成 1 份素材，可加入项目",
        "items": [
          {
            "index": 0,
            "status": "completed",
            "promptId": "fixture-0",
            "assets": [
              {
                "id": "7beb75ae-805d-4525-a12f-21620868832c",
                "outputKey": "[\"2\",\"fixture-0-0.png\",\"\",\"output\"]"
              }
            ]
          }
        ],
        "assets": [
          {
            "id": "7beb75ae-805d-4525-a12f-21620868832c",
            "name": "fixture-0-0.png",
            "type": "image/png",
            "size": 68,
            "category": "生成素材",
            "tags": [
              "isolated cascade specialized"
            ],
            "source": "comfy",
            "createdAt": "2026-10-07T08:34:05.339Z",
            "url": "/media/7beb75ae-805d-4525-a12f-21620868832c",
            "enhancement": {
              "kind": "upscale",
              "engine": "comfy",
              "sourceAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
              "originalAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
              "resolution": 4096,
              "maxResolution": 4096,
              "seed": 5678
            }
          }
        ],
        "applied": false,
        "imageBindings": [
          {
            "nodeId": "15",
            "name": "image",
            "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca"
          }
        ],
        "inputMappings": [
          {
            "nodeId": "15",
            "name": "image",
            "assetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
            "uploaded": {
              "name": "fixture-reference.png",
              "subfolder": "",
              "type": "input"
            },
            "value": "fixture-reference.png"
          }
        ],
        "inputPrepared": true,
        "inputPreparation": "completed",
        "cascadeEnhancement": {
          "kind": "upscale",
          "engine": "comfy",
          "resolution": 4096,
          "maxResolution": 4096,
          "seedMode": "fixed",
          "sourceAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
          "sourceIdentity": "f9e4188a609c7cce0231418e4c9dc7d2f71f65ff9730e71f9e73b72fe24bd669",
          "workflowId": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
          "workflowRevision": 0,
          "seed": 5678
        }
      }
    ],
    "workflows": [
      {
        "id": "f19fcbb6-5d86-4971-bbcc-d9b17f213c97",
        "name": "isolated cascade specialized",
        "workflow": {
          "15": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "input.png"
            }
          },
          "172": {
            "class_type": "SeedVR2VideoUpscaler",
            "inputs": {
              "seed": 30,
              "resolution": 2048,
              "max_resolution": 4096,
              "image": [
                "15",
                0
              ]
            }
          },
          "174": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "172",
                0
              ],
              "filename_prefix": "upscale"
            }
          }
        },
        "inspection": {
          "nodeCount": 3,
          "nodes": [
            {
              "id": "15",
              "class_type": "LoadImage",
              "title": null,
              "inputs": [
                {
                  "name": "image",
                  "type": "string",
                  "value": "input.png"
                }
              ]
            },
            {
              "id": "172",
              "class_type": "SeedVR2VideoUpscaler",
              "title": null,
              "inputs": [
                {
                  "name": "seed",
                  "type": "number",
                  "value": 30
                },
                {
                  "name": "resolution",
                  "type": "number",
                  "value": 2048
                },
                {
                  "name": "max_resolution",
                  "type": "number",
                  "value": 4096
                }
              ]
            },
            {
              "id": "174",
              "class_type": "SaveImage",
              "title": null,
              "inputs": [
                {
                  "name": "filename_prefix",
                  "type": "string",
                  "value": "upscale"
                }
              ]
            }
          ]
        },
        "revision": 0,
        "fields": [],
        "createdAt": "2026-10-07T08:34:05.282Z"
      },
      {
        "id": "f9ca8b47-fdf8-4108-b57f-d9daf33bfa27",
        "name": "本机合成输出",
        "workflow": {
          "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
              "text": "未替换"
            }
          },
          "2": {
            "class_type": "SaveImage",
            "inputs": {
              "images": [
                "1",
                0
              ]
            }
          },
          "3": {
            "class_type": "LoadImage",
            "inputs": {
              "image": "未上传.png"
            }
          }
        },
        "inspection": {
          "nodeCount": 3,
          "nodes": [
            {
              "id": "1",
              "class_type": "CLIPTextEncode",
              "title": null,
              "inputs": [
                {
                  "name": "text",
                  "type": "string",
                  "value": "未替换"
                }
              ]
            },
            {
              "id": "2",
              "class_type": "SaveImage",
              "title": null,
              "inputs": []
            },
            {
              "id": "3",
              "class_type": "LoadImage",
              "title": null,
              "inputs": [
                {
                  "name": "image",
                  "type": "string",
                  "value": "未上传.png"
                }
              ]
            }
          ]
        },
        "revision": 0,
        "fields": [],
        "createdAt": "2026-10-07T08:34:05.273Z"
      }
    ],
    "assets": [
      {
        "meta": {
          "id": "7beb75ae-805d-4525-a12f-21620868832c",
          "name": "fixture-0-0.png",
          "type": "image/png",
          "size": 68,
          "category": "生成素材",
          "tags": [
            "isolated cascade specialized"
          ],
          "source": "comfy",
          "createdAt": "2026-10-07T08:34:05.339Z",
          "url": "/media/7beb75ae-805d-4525-a12f-21620868832c",
          "enhancement": {
            "kind": "upscale",
            "engine": "comfy",
            "sourceAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
            "originalAssetId": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
            "resolution": 4096,
            "maxResolution": 4096,
            "seed": 5678
          }
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "e149bcb3-bd98-4b71-9fd9-0106d70200ca",
          "name": "A.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:34:05.275Z",
          "url": "/media/e149bcb3-bd98-4b71-9fd9-0106d70200ca"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "7d2c9789-1381-4807-bdbd-1314b8a67ed9",
          "name": "B.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:34:05.278Z",
          "url": "/media/7d2c9789-1381-4807-bdbd-1314b8a67ed9"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      },
      {
        "meta": {
          "id": "bfe13afd-4cb2-4900-98dc-047a9bfcef30",
          "name": "C.png",
          "type": "image/png",
          "size": 68,
          "category": "",
          "tags": [],
          "source": "import",
          "createdAt": "2026-10-07T08:34:05.279Z",
          "url": "/media/bfe13afd-4cb2-4900-98dc-047a9bfcef30"
        },
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR8sAAAAASUVORK5CYII="
      }
    ]
  }
];
