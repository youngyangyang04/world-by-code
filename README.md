# world-by-code

用代码创造世界。

这个仓库收集一系列用代码生成的景观和场面：山川、战场、城池、天象。每个作品都是一个可以在本地直接运行的独立项目，画面由代码实时渲染出来，不是视频，也不是预先渲染好的图片。

代码由 AI 编写（目前是 Claude Fable 5.2 + Claude Code），我负责提需求、看效果、一轮轮地改。全部开源，欢迎下载体验，也欢迎拿去让 AI 继续魔改。

## 作品

| 作品 | 简介 | 技术 |
| --- | --- | --- |
| [大漠铁骑](./desert-cavalry/) | 河西走廊，日暮。第一人称骑在战马上，与上千骑大唐铁骑一起冲锋的 20 秒实时 3D 演出 | Three.js、WebGL2、GLSL、Web Audio、Vite |

[![大漠铁骑](./desert-cavalry/docs/images/01-charge-front.jpg)](./desert-cavalry/)

更多作品会陆续加进来。

## 怎么运行

每个作品是一个独立目录，互不依赖，进入目录按它自己的 README 操作即可。以大漠铁骑为例：

```bash
git clone https://github.com/youngyangyang04/world-by-code.git
cd world-by-code/desert-cavalry
npm ci
npm run dev       # 打开 http://127.0.0.1:5173
```

需要 Node.js 20.19 或更高版本，以及支持 WebGL2 的桌面浏览器。

## 仓库结构

```
world-by-code/
  README.md            本文件
  desert-cavalry/      大漠铁骑
    README.md          效果图、启动方法、安全部署、实现说明
    ASSETS.md          外部素材的作者、许可证、来源
    src/  public/  ...
  <下一个作品>/
```

每个作品目录都遵守同样的约定：

- **独立可运行。** 自带 `package.json` 和锁文件，不依赖仓库里的其他作品。
- **自带 README。** 写清楚效果、启动方法和部署方法。
- **素材有出处。** 用到的外部模型、贴图、音频都在该作品的 `ASSETS.md` 里列出作者、许可证和来源；代码生成的部分也会说明。
- **如实说明完成度。** 哪些是过渡方案、哪些没测过，README 里直接写出来。

## 许可

- **代码**：[PolyForm Noncommercial 1.0.0](./LICENSE.md)。可以自由学习、修改、非商业使用。**商业使用需要单独申请商用许可**，联系方式见 [LICENSE.md](./LICENSE.md)。
- **外部素材**各自遵循原作者的许可证，详见每个作品的 `ASSETS.md`。其中有的素材带限制条件（例如大漠铁骑的战马模型是 CC BY-ND 4.0），二次发布或商用前请先看清楚。

## 支持

觉得有意思的话，点个 Star。有想看的景观或场面，可以提 Issue。
