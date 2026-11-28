## 完整运维功能开发

本目录提供带 NightWarden、备份和恢复的运维工作台、后台和测试。根目录是公开 beta 插件的构建入口。两个入口共用一个 Git 仓库。修改本目录后，从本目录构建和联调扩展工作台。

| 修改目标 | 入口与调用关系 |
| --- | --- |
| 工作台和原生运维会话 | `client.js` 展示页面，`plugin.js` 路由请求，`workspace-tool.js` 注册工具。会话里的备份、历史查询和恢复确认分别由 `conversation-backup.js` 和 `conversation-recovery.js` 处理。 |
| NightWarden | `agent.js` 接入 `nightwarden-workbench.js`；`nightwarden-client.js` 访问调查 API。`nightwarden-duty.js`、`nightwarden-policy.js` 和 `nightwarden-decisions.js` 处理采样、规则、人工决定和持久化回执。`nightwarden-deploy.py` 负责专属实例，`rehearsal/` 包含值班服务和指标采集的安装代码。 |
| 工作区备份与文件历史 | `google-drive.js` 把工作台请求交给已登记主机。`base-backup/workspace.py` 封存、上传和回读验证，`google_drive.py` 管理第二个目的地，`workspace_history.py` 浏览时点、比较变更并恢复到新目录。对应 systemd 单元在同目录。 |
| 整机与组件恢复 | `base-backup/server_recovery.py` 处理组件归档与验证，`open-recovery-package.py` 校验、解密并重组分卷。`google-server-backup.sh` 和 `google-server-receipt.sh` 生成 restic 快照与回执，`rehearse-google-server.py` 在独立磁盘镜像上演练恢复。见[恢复说明](base-backup/restore.md)。 |
| 开发演练 | `backup.js`、`groups.js` 和 `rebuild.mjs` 包含加密增量、组件组和从云端重建目录的实现。`test/` 使用合成事件、临时 SQLite、模拟网盘以及本地文件型 rclone 目标。 |

### 在 Linux 检出后运行

在仓库根目录执行以下命令。Node.js 需要 22.13 或更新版本，Python 需要 3.10 或更新版本。

```sh
npm ci --ignore-scripts
npm test
npm run test:operations
python3 -m venv .venv
.venv/bin/python -m pip install -r operations/requirements.txt
.venv/bin/python operations/test_python.py
```

运行完整文件恢复集成测试还需要系统命令 `duplicity`、`gpg`、`rsync` 和 `rclone`。Debian 可通过同名软件包安装，`gpg` 也可随 `gnupg` 安装。测试输出的 `skipped` 表示相应依赖缺失。测试只需临时目录和回环连接。

### 为自己的服务器准备配置

源码中的主机、SSH 别名和目录是示例值。开发测试可以直接使用这些值。需要对接自己的部署时，把 [site.example.json](site.example.json) 复制到仓库外，填写账本中的主机 ID、已核对的 SSH 别名、`/data` 下的工作区父目录与归档目录，以及 `/var/lib` 下的私有配置目录。以下命令在仓库外的新目录生成对应源码和 systemd 单元。

```sh
python3 tools/prepare-operations.py ~/ops-site.json ~/ops-runtime-src
```

在生成目录中可用 `npm ci --ignore-scripts && npm run build:plugin` 构建扩展版。源码修改应在 Git 检出中完成。集中配置涵盖上述五项；应用容器、探针、磁盘和挂载布局还需按现场调整，重点核对 `appnode-monitor.py`、`check-edge.py`、`base-backup/server_recovery.py` 的来源表和整机脚本。整机演练附带的是双盘、BIOS/EFI 分区及独立应用挂载的示例。

Linux 上使用 `SERVER_OPS_STATE` 指定独立账本目录，`DSH_BIN` 可指定 DSH CLI。DSH 宿主联调扩展工作台时，插件和后台使用同一 `SERVER_OPS_STATE`。macOS 的 `install.py` 是 LaunchAgent 安装入口。NightWarden 的镜像在部署时下载，模型设置工具从运行环境读取 `DSH_MODEL_BASE_URL`、`DSH_MODEL_ID`、`DSH_MODEL_API_KEY`。

各后端单独配置。百度上传使用已授权的 bdpan，`DSH_BDPAN_BIN` 可指定程序路径。百度批量下载 API 从 `DSH_BAIDU_TOKEN_FILE` 或私有目录里的 `baidu-access-token` 读取当前 OAuth token，文件归运行用户所有、权限 0600，轮换后下一次请求会重新读取。Google 目标使用私有目录里的 rclone 配置；duplicity、GPG 和 restic 的恢复密钥由部署方单独保管。运行账户、授权文件、已有恢复点和生产账本均需要在自己的环境中接入。
