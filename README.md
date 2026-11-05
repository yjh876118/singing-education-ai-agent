# 直播高光短视频剪辑智能体（MVP）

中文可运行原型，面向银发歌唱教育直播回放：上传视频、粗筛可能有活动的音频区间、人工审核/修改、预览原片、导出 MP4 片段，并下载中文剪辑计划。

## 重要范围说明

当前候选算法只根据音频能量粗筛，**不等于语义高光识别**，不能判断唱法示范、教学价值或观众反应。输出需要人工审核。当前 MVP 也尚未接入 HyperFrames 正式合成渲染；剪辑计划中的片头片尾、字幕、动画、图形与授权音乐是下一阶段输入，不应误认为已经渲染进 MP4。

## 环境与启动

需要 Node.js 20+、FFmpeg 和 ffprobe（在 PATH 中）。

```bash
npm install
npm start
```

打开 http://localhost:3000。上传支持 MP4、MOV、MKV、WebM、M4V，默认最大 1GB。数据暂存在本地 `data/` 目录。

> 当前没有账号、多租户、持久化数据库、对象存储或上传病毒扫描，不适合直接暴露公网。部署前必须补齐鉴权、HTTPS、访问权限、存储保留/删除策略和授权检查。

## 当前 API

- `GET /api/health`：服务状态
- `POST /api/jobs`：multipart/form-data 上传字段 `video`
- `GET /api/jobs/:id`：任务状态和候选片段
- `GET /api/jobs/:id/source`：受任务 ID 控制的原片预览
- `PATCH /api/jobs/:id/highlights/:highlightId`：修改候选起止秒数和标题
- `POST /api/jobs/:id/renders`：导出所选 MP4 切片
- `GET /api/jobs/:id/plan`：下载中文剪辑计划 JSON
- `GET /api/files/:filename`：下载导出文件

## 下一步

1. 接入中文 ASR 和内容理解，按知识价值、完整性、独立成片性、教学互动等维度排序高光，并显示证据与置信度。
2. 接入 HyperFrames：生成可编辑项目，加入逐句字幕、适龄动画/图形、授权音乐与同源静态海报片头片尾；运行检查、预览和渲染，并自动比较首尾帧。
3. 增加安全生产能力：登录权限、任务队列、对象存储、断点续传、审计和自动清理。

HyperFrames 官方项目：https://github.com/heygen-com/hyperframes
