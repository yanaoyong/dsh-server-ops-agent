# DSH 服务器运维 Agent

DeepSeek Harness 的 Linux 运维插件。通过已有 SSH 连接读取服务器采样、巡检日报和事件证据，在 DSH 中提供绑定服务器的原生运维会话。

## 安装并连接

1. 在 DSH 添加 `dsh-server-ops-agent@beta`，或使用 GitHub 预发布中的同版插件包离线安装。
2. 打开侧栏「服务器运维」，填写 SSH 主机、端口、用户和管理员核对过的 SHA256 主机指纹。选择「验证并连接」。
3. 已部署的服务器直接连接。首次部署时，管理员确认目标、版本和权限后，插件上传同版本 Linux 包并校验，部署后重新连接。普通 SSH 用户可以把指引中的命令交给服务器管理员。
4. 在「值班」查看容量采样、趋势和事件，在「日报」查看每日巡检记录，或从「运维 Agent」打开原生会话。

本版面向 DSH `0.2.2-rc.5` 和运行 systemd 的 Linux。服务器通过独立账户运行服务，在本机 SQLite 保存采样。运维会话使用只读工具。

- [安装、升级和运行时依赖](DSH-Linux-首次连接.md)
- [下载插件、Linux 包和校验值](https://github.com/yanaoyong/dsh-server-ops-agent/releases)
- [公开分发方案](docs/distribution.md)

在 DSH 启用「自定义插件索引」，把公开索引添加到「发现」，即可查看并安装指定版本。 [DSH 服务器运维索引](https://raw.githubusercontent.com/yanaoyong/dsh-server-ops-agent/main/index.json)

## 从源码构建

构建机需要 Node.js 22.13 或更新版本及 Python 3。检出目标版本标签后运行：

```sh
npm ci --ignore-scripts
npm test
mkdir -p dist
npm pack --pack-destination dist
cp generated/linux-release.tgz dist/server-ops-agent-linux-0.3.0-beta.1.tgz
```

`npm pack` 会生成 Linux 发行包并原样内置到 DSH 插件。发布时将同一份 Linux 包和两份产物的 SHA-256 上传到 GitHub 预发布，并把已验收的插件包发布到 npm 的 `beta` 标签。

本项目采用 [MIT 许可证](LICENSE)。插件包内的 `generated/ssh-licenses.txt` 记录 SSH 依赖的许可。
