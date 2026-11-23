# 在 DSH 连接 Linux

公开 beta 为 `0.3.0-beta.1`。DSH 兼容版本为 `0.2.2-rc.5`。Linux 需要 systemd、OpenSSH、Python 3、`flock`、`ss` 及可运行 Node.js 的 glibc 环境。安装器接受 Linux ARM64 与 x64。两端使用同一个发行版本。

## 使用 DSH 安装

在 DSH 添加插件 `dsh-server-ops-agent@0.3.0-beta.1`。使用 GitHub 预发布中的插件包离线安装时，将下载路径传给 DSH CLI。

```sh
dsh plugin --profile ops-workbench add "file:/path/to/dsh-server-ops-agent-0.3.0-beta.1.tgz" --offline
```

1. 打开侧栏的「服务器运维」，填写 SSH 主机、端口和用户。使用服务器管理员核对过的 SHA256 主机指纹。
2. 选择「验证并连接」。已有服务会直接连接。首次部署时，有 root 或免密 sudo 的账号可在核对目标与版本后选择「确认部署并连接」。普通账号可将页面上的命令交给管理员。
3. DSH 在 SSH 会话中上传并校验内置的同版发行包。安装后会重新连接，让 SSH 用户取得运维读取组权限。值班页显示真实容量采样、本机 SSH 服务状态和最近同步时间。「运维 Agent」可打开绑定该主机的原生会话。

SSH 私钥可使用本机未加密私钥的绝对路径。留空时，插件尝试 SSH agent 及默认私钥。加密私钥可先加入 SSH agent。私钥保留在 DSH 宿主。

## 手工安装与升级

从 GitHub 预发布下载 `server-ops-agent-linux-0.3.0-beta.1.tgz` 和 `SHA256SUMS`。核对该文件的 SHA-256 后解压。服务器上执行以下命令，将 `opslogin` 替换为实际 SSH 用户。

```sh
sudo sh install-linux.sh install
sudo usermod -aG server-ops-read -- opslogin
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

已安装旧版本时，使用新版安装包中的 `sudo sh install-linux.sh upgrade`。安装器在升级失败时恢复旧版本、systemd 单元与 SSH 入口，并复查原服务。重复执行同版 `install` 会沿用现有安装与 SQLite 账本。使用 `start` 或 `stop` 启动或停止服务。

安装器优先使用带 SQLite 的 Node.js 22.13 或新版，否则在专用目录安装通过 SHA-256 校验的官方 Node.js 22.23.5。离线安装可以预装兼容 Node，或将对应架构的 [官方 Node.js tar.xz](https://nodejs.org/dist/v22.23.5/) 放到安装器旁边。安装器不会更改系统默认 Node。

服务账户为 `server-ops`，账本目录为 `/var/lib/server-ops-agent`，SSH 入口为 `/usr/local/bin/dsh-server-ops`。可在 `/etc/server-ops-agent.conf` 设置 `SERVER_OPS_HOST_ID` 和 `SERVER_OPS_SSH_PORT`。默认观察服务器本地的 SSH 端口 22。更改配置后运行 `sudo systemctl restart server-ops-agent`。升级后 DSH 会继续使用已登记的服务器标识和工作区。
