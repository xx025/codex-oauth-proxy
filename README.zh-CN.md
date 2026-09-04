# ECRelay

[English](README.md) | 简体中文

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xx025/ecrelay)

把 ChatGPT OAuth、Antigravity 账号和自定义 OpenAI 兼容上游统一路由为运行在 Cloudflare Workers 上的 API。

可用于对外提供 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 和 `/mcp`，并在同一个管理面板中管理内置账号与自定义上游。

> 本项目使用非官方上游接口。请只使用自己有权控制的账号，并遵守相关条款。

## 测试站点

- 地址：<https://ecrelay.vktest.workers.dev/>
- 密码：`admin`

请不要在公开测试站点输入私人信息、个人 Token、生产 API Key 或重要账号。

## 功能

- OpenAI 兼容的 `/v1/models`、`/v1/chat/completions` 和 `/v1/responses`
- ChatGPT OAuth 和 Antigravity 账号管理
- 自定义 OpenAI 兼容 API、模型发现和 fallback
- 多账号轮询、Token 刷新、冷却和故障转移
- 流式响应、客户端 API Key、请求统计和模型测试
- Cloudflare Workers、Durable Objects 和强制 VPC 出口

## 截图

![管理面板](docs/image.png)

## 部署

参阅[部署文档](docs/deployment.zh-CN.md)。

## 使用

打开管理面板后，可以添加 ChatGPT 或 Antigravity 账号、接入自定义 OpenAI 兼容 API，并创建客户端 API Key。请求优先使用内置提供方；自定义 API 可提供独有模型，也可按优先级作为 fallback。**模型** 页面支持单模型和批量可用性测试。

```bash
curl https://YOUR_WORKER_DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 本地开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## 致谢

本项目在开发过程中借鉴、参考并使用了以下开源项目：

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)
- [dvcrn/codex-oauth-proxy](https://github.com/dvcrn/codex-oauth-proxy)

特别感谢 **Cloudflare** 平台提供的慷慨免费计划与优秀的开发者生态。

## 许可证

[MIT](LICENSE)
