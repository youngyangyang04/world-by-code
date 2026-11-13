# 资源清单与许可证

所有外部资源都是真实下载到 `public/assets/` 的文件；没有任何“假装已加载”的资源。音频缺失时引擎会改用合成兜底并在控制台列出。

## 模型

| 文件 | 内容 | 作者 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| `models/horse_run.glb` | 写实战马 + 35 帧奔跑顶点动画，15.6k 三角形，1024² 贴图 | 动画：Amitesh Nandan；模型：Tomasz Jurczyk；贴图：Didac Ruiz；绑定：Carlos Contreras | CC BY-ND 4.0 | https://sketchfab.com/3d-models/horse-run-b7421fcc3b9b4065b2b330a3bc7e9a79 （文件取自 github.com/Barraka/horseGame 的镜像） |

**关于这匹马，有两点必须说明：**

1. **禁止演绎（ND）。** 文件原样分发，未做任何修改（未减面、未改贴图、未重新导出）。循环截取、去根位移、毛色着色、马甲壳层都是加载后在运行时做的。运行时处理是否算“演绎”我无法替你下法律结论；如果要公开发布或商用，建议换成许可更宽松的模型。
2. **授权链不完整。** 上传者在原页面写明“模型、贴图、绑定不是我的”。也就是说他是否有权以 CC BY-ND 授权这个网格，无法核实。个人演示问题不大，正式发布前应当替换。

骑手、鞍具、兵器、马甲、马鬃、战旗全部是本项目代码生成的几何体与贴图，没有外部文件。

## 地表贴图（Poly Haven，全部 CC0）

| 文件前缀 | 用途 | 作者 | 来源 |
| --- | --- | --- | --- |
| `sand_01_*_2k.jpg` | 细沙 | Rob Tuytel | https://polyhaven.com/a/sand_01 |
| `sandy_gravel_02_*_2k.jpg` | 砾石戈壁 | Dario Barresi | https://polyhaven.com/a/sandy_gravel_02 |
| `cliff_side_*_2k.jpg` | 远山岩面、碎石 | James Ray Cock、Dario Barresi、Jenelle van Heerden | https://polyhaven.com/a/cliff_side |

每组含 diff / nor_gl / rough 三张 2048² JPG。

## 音频

`public/assets/audio/` 下每个名字都有 `.ogg` 和 `.mp3` 两份（44.1 kHz，128 kbps，由原始文件截取转码）。

| 文件 | 用途 | 作者 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| `gallop_close` | 邻近战友的马蹄（空间化循环） | Antum Deluge，基于 Alan McKinney 的录音 | **CC BY 3.0（需署名）** | https://opengameart.org/content/horse-gallop-loop |
| `stampede` | 群马低频轰鸣 | DenisChardonnet | CC0 | https://bigsoundbank.com/horses-s0289.html |
| `whinny` | 嘶鸣 | Joseph Sardin | CC0 | https://bigsoundbank.com/horse-neighing-4-s1541.html |
| `whinny_alt` | 嘶鸣 | DenisChardonnet | CC0 | https://bigsoundbank.com/neighing-of-a-horse-1-s0284.html |

按要求，声音只保留**马蹄**与**马嘶鸣**两类。

程序合成（无文件）：自己坐骑的四蹄落地声、群蹄低频轰鸣的次低音层、嘶鸣用的混响冲激响应。

**音频质量的实话：**

- `stampede`：来源页只写“Horses”，是否真的是多匹马奔跑不确定；现在靠两层变速叠加 + 合成低频撑起“千军万马”的感觉。
- 这些素材我只做了解码与电平检查，没有试听。

## 效果图

`docs/images/` 下的四张图是本项目运行时的截图，只用于 README 展示，不参与构建。

## 想替换战马模型的话

选型时比较过的其他来源，许可都比现在这匹清晰，但写实程度或动画质量不如它：Quaternius 的马（CC0，低多边形）、Mesh2Motion 的马（CC0，带骨骼奔跑动画）、three.js 示例里的 Horse.glb、0 A.D. 的骑兵套件（CC BY-SA 3.0）。这些文件没有放进本仓库。换模型需要改 `src/cavalry/horseAsset.js` 里的加载与烘焙逻辑：现在的代码假定模型是带 35 个形变目标的顶点动画，不是骨骼动画。
