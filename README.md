# DSH 服务器运维 Agent

DeepSeek Harness 的 Linux 运维插件。它通过已有 SSH 连接读取服务器采样、巡检日报和事件证据，在 DSH 中提供绑定到服务器的原生运维会话。

**公开预览筹备中。** 首版安装入口、兼容平台和两端安装包将在 [GitHub Releases](https://github.com/yanaoyong/dsh-server-ops-agent/releases) 公布。

## 首版的使用方式

1. 在 DSH 安装插件，打开「服务器运维」。
2. 配置 SSH 主机、端口、用户和主机指纹，使用现有 SSH 身份。
3. 已部署的服务器直接连接。首次部署时，具备管理员权限的用户在 DSH 确认安装，插件完成部署和重连。普通 SSH 用户可以把安装命令交给服务器管理员。
4. 看到首条采样后，从值班页查趋势、日报和事件，或打开原生运维会话。

服务器端使用独立服务账户和 SQLite 保存采样。DSH 与服务器通过 SSH 通信。公开首版提供只读巡检与取证，服务器安装和升级由用户确认。

[公开分发方案](docs/distribution.md)
