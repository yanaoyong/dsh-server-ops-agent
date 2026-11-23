# DSH 服务器运维插件公开分发方案

首版采用 **npm 分发 DSH 插件、GitHub Releases 分发 Linux 服务、DSH 索引用于发现**。两端产物使用同一版本号，Linux 服务通过既有 SSH 连接接入。公开预览以通用 Linux 巡检、日报、事件证据和 DSH 原生运维会话为范围。

## 安装与首次连接

| 用户操作 | 插件或安装器的行为 |
| --- | --- |
| 在 DSH 查找并安装插件 | npm 产物包含前端、服务端适配层和 SSH 客户端。包声明已验证的 DSH 版本。 |
| 配置 SSH | 使用现有 SSH 身份并核对主机指纹。插件读取服务器服务状态、版本和能力。 |
| 确认首次部署 | 插件展示目标服务器、版本及所需权限。具备权限时，通过 SSH 上传匹配版本的安装包，校验发行包并运行固定安装入口。安装器初始化 systemd 服务和读取权限。如果账号权限不足，界面提供管理员可以执行的命令。 |
| 打开值班页 | 安装成功后重新建立 SSH 连接，显示首条容量采样、服务器本机 SSH 状态和最近一次 DSH 同步时间。用户可打开本机事件或原生会话。 |

预编译的 Linux 安装包在 Release 页面提供离线下载。安装器检查架构和依赖，在缺少兼容 Node 时使用服务专用运行时，重复安装沿用原账本。升级失败时恢复旧版本和启动配置，并复验固定入口。

## 发布渠道与版本

1. 源码仓库保存公开代码、兼容矩阵、安装文档和变更记录。包使用 `dsh.bundle.patch` 和 `engines.dsh` 声明。 [DSH 打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
2. 从一个版本标签构建 DSH npm 包、支持架构的 Linux 安装包和 SHA-256 清单。先把同版本两端产物上传 GitHub 预发布，再将已验收的插件 tarball 发布到 npm 的 `beta` 标签。 [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) · [npm 分发标签](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)
3. npm 可安装性验证通过后，将精确版本加入 DSH 的公开插件索引。社区用户也可在「添加插件」中按包名安装。 [DSH 插件索引规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)

## 社区插件参考

- **dsh-context** 的版本页提供 npm 安装、更新入口和版本说明。每个服务器运维 Release 也把两端安装指引、兼容范围和变更放在一起。 [dsh-context Releases](https://github.com/bowenliang123/dsh-context/releases)
- **dsh-lark** 的安装与配置在 DSH 内完成，其发布流程把验证、打包和 npm 分发关联到 GitHub Release。服务器运维插件沿用一个标签和可追溯产物，后续可用 npm Trusted Publishing。 [dsh-lark](https://github.com/sugarforever/dsh-lark#版本与发布) · [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- **开放插件市场** 提供 DSH 社区发现入口。公开包先支持按包名直接安装，再进入索引。 [开放插件市场](https://github.com/polang233/dsh-plugin-index)

## 首版发布验收

- 用干净 DSH 配置和新 Linux 完成首次安装，确认可配置 SSH、看到真实采样并打开原生会话。
- 复验普通账号权限不足的指引、主机指纹不符、重复安装、断线恢复和服务升级失败回滚。
- 对实际 GitHub 附件和 npm tarball 检查文件白名单、许可和校验值。演示仅使用隔离环境与合成数据。源码、包、日志和截图排除真实连接信息、凭据、内部路径和账本。
- 从公开 npm 安装指定版本，从公开索引核对发现结果和安装来源，记录已验证的 DSH 与 Linux 版本。
