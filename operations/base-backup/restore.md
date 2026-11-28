## 组件分卷与整机快照恢复

工作区的文件历史由 `workspace_history.py` 管理。选择时点和相对路径后，恢复任务把内容写到独立目录，并记录请求编号。可以在运行 `operations/test_python.py` 时用本地 rclone 目标验证文件回读、增量及删除文件的恢复。

百度组件归档包含索引、组件清单及加密分卷。在隔离目录使用自己的备份批次和目录记录。命令中的环境变量引用由操作者提供的路径和编号。

```sh
python3 workspace.py recovery-fetch "$RUN_ID" "$CATALOG_NAME" "$DOWNLOAD_DIR" \
  --token-file "$BAIDU_TOKEN_FILE" --recovery-key "$RECOVERY_KEY_FILE"
python3 open-recovery-package.py "$MANIFEST_FILE" "$RECOVERY_KEY_FILE" "$NEW_TAR_FILE"
```

解包工具逐卷核对字节数和 SHA-256，再执行 GPG 认证解密、zstd 解压和 tar 目录检查。输出 tar 使用新文件名。组件清单记录各自的采集时间。

Google 整机示例使用 rclone remote `dsh-google` 和 restic 仓库 `server-recovery/restic-v1`。在独立恢复机上准备只读网盘访问和独立保管的密钥。先列出快照，核对备份回执里的快照 ID，读取布局和校验仓库。

```sh
export RESTIC_REPOSITORY=rclone:dsh-google:server-recovery/restic-v1
restic snapshots --tag google-server-online
restic check --read-data
restic ls "$SNAPSHOT_ID" /layout
```

`RCLONE_CONFIG` 和 `RESTIC_PASSWORD_FILE` 指向仓库外的私有文件。`rehearse-google-server.py` 需要 Linux、restic、rclone、util-linux、文件系统工具、GRUB 和 QEMU。它用快照里的布局创建新的镜像并在隔离环境校验启动和应用。示例布局的设备及分区在备份脚本与演练脚本中成对定义；采用其他布局时应同时修改两者。在线文件系统的恢复验证还要覆盖业务数据库和服务本身。

部署整机备份单元时，将本文安装至 `/usr/local/share/dsh-google-server/restore.md`，随快照写入 `layout/`。Mac 端的可选演练控制器将 `rehearse-google-server.py` 作为隔离 Linux 中的 `/usr/local/libexec/dsh-rehearse-google-server.py` 调用。
