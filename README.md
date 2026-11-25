# STSync

STSync 是适配 SillyTavern、Luker 与 TauriTavern 的云端同步系统，用于将全部数据上传至你的服务器或从服务器下载，支持增量与镜像两种同步模式。多端可连接同一台服务器并共用同一份云端数据。

## 特性

- **支持的酒馆**：SillyTavern、Luker（SillyTavern 分支，自动识别，另有「Luker 专属」数据类别）、TauriTavern（使用其内置同步方式）；其他基于 SillyTavern 的分支可手动指定目录安装，面板会提示「未识别的酒馆」。
- **完整数据同步**：覆盖角色卡、聊天记录、群组、用户角色、世界书、预设与提示词模板、快速回复、外观、媒体与用户文件、扩展、向量库、备份（默认不同步）、设置与 API 密钥、Luker 专属（card-apps 卡片应用、skills 技能）。
- **内容定义分块去重**：采用 FastCDC 算法（块大小 16–256 KB，平均约 64 KB），仅传输接收端缺失的数据块。
- **断点续传与传输压缩**：已上传或已下载的数据块保留在本地/服务端缓存中，中断后重试自动跳过；块数据按批次打包并以 zstd 压缩（不支持时回退至 brotli）。
- **低门槛接入**：通过服务器地址与 `sts1.<令牌>.<证书指纹>` 格式的 API Key 即可配对设备，支持多设备复用及新设备接入开关。
- **传输与系统安全**：TLS 1.3 自签证书配合 SPKI 证书固定、ed25519 设备会话签名、ufw 按来源 IP 限速（每分钟 30 次、突发 60 次），服务端运行于非特权用户 `stsync` 与 systemd 沙箱中。
- **兼容 TauriTavern**：SillyTavern 与 Luker 使用 STSync 同步协议（`/api/v1`），TauriTavern 使用其内置客户端通过 `/v2` 接口连接同一服务器；服务端运行官方 `tt-sync` 程序并共用同一 SillyTavern 目录结构的工作区。

## 快速开始

没有用过服务器也没关系，跟着下面四步走，大约 10 分钟就能用上。

### 第 1 步：准备一台服务器

1. 买一台最便宜的云服务器就够用，系统选 **Debian** 或 **Ubuntu**。
2. 记下厂商给你的 **IP 地址** 和 **root 密码**。
3. 在电脑上用 SSH 工具登录服务器：Windows 可以直接在「终端」里输入 `ssh root@你的IP`，也可以用 FinalShell、Termius 这类软件。

### 第 2 步：在服务器上安装 STSync

1. 登录服务器后，复制下面这一行命令，粘贴到服务器的命令行里并回车：

   ```sh
   curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/install.sh | sudo sh
   ```

2. 等几分钟，最后会显示一段「安装完成」，把里面的两样东西**先复制保存好**：
   - **服务器地址**，形如 `https://1.2.3.4:8443`
   - **API Key**，以 `sts1.` 开头的一长串

> **注意：**云服务器控制台里通常还有一个「**安全组**」或「**防火墙**」设置。请在里面放行 **TCP 8443** 端口，否则酒馆连不上服务器。

### 第 3 步：在酒馆里安装插件

#### 手机（Termux）上的 SillyTavern

1. 打开 Termux，运行下面这一行命令。它会自动找到 SillyTavern，装好扩展和服务端插件：

   ```sh
   curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/st-install.sh | sh
   ```

   缺少 `git` 或 `node` 时脚本会自动用 `pkg` 安装；如果提示没有 `curl`，先运行 `pkg install curl git nodejs`。

2. 重启 SillyTavern：在运行 SillyTavern 的 Termux 窗口按 `Ctrl+C` 停止，再运行：

   ```sh
   cd ~/SillyTavern && ./start.sh
   ```

#### 电脑上的 SillyTavern

1. 打开 SillyTavern → 顶部的「扩展」（积木图标）→「安装扩展」。
2. 填入 `https://github.com/lingyidaze/stsync`，点安装。
3. 在 SillyTavern 文件夹里打开命令行（Windows 可以在文件夹地址栏输入 `cmd` 回车），运行命令安装服务端插件：

   ```sh
   node data/default-user/extensions/stsync/st-plugin/install.mjs
   ```

4. 关掉 SillyTavern，重新启动。

Linux、macOS 电脑也可以直接用上面 Termux 的那一行命令。

服务端插件只需要装一次：以后在扩展页更新 STSync，插件会跟着更新，重启 SillyTavern 后生效。

#### TauriTavern

在扩展页用同一个地址 `https://github.com/lingyidaze/stsync` 安装即可，不需要服务端插件。

### 第 4 步：连接并同步

1. 在扩展页找到「STSync」，展开面板。
2. 先看面板顶部的「后端检测」是否显示绿色「服务端插件正常」（不正常时照卡片里的命令修复，见[常见问题](#常见问题)）。
3. 填入第 2 步保存的服务器地址和 API Key，点「连接」，看到「已连接」就成功了。
4. 想把这台设备的数据传到云端，就点「**上传到云端**」；想把云端数据拿到这台设备上，就点「**从云端下载**」。
5. 每台要同步的设备都重复第 3、4 步。全部连好后，回到服务器运行 `stsync lock`，别人就算拿到 Key 也接不进来。

## 日常使用

### 面板各部分说明

- **顶部状态与后端检测**：
  - 面板标题栏右侧显示当前状态徽标（已连接 / 未连接 / 同步中 / 后端异常）。
  - 面板顶部设有「**后端检测**」卡片。在 SillyTavern 中用于显示服务端插件状态：
    - 正常时显示绿色「服务端插件正常」和版本号（同时显示酒馆名称与版本，如「Luker 2.9.0 · 服务端插件 v1.1.1」）；
    - 酒馆不是已验证过的 SillyTavern / Luker（例如其他分支）时，显示橙色「未识别的酒馆：<名称> <版本>」警告——仍可使用，但提示同步前先备份数据、先用「增量」模式小范围试用、尽量不要用「镜像」模式；
    - 未安装或 `config.yaml` 未开启 `enableServerPlugins` 时显示「未检测到服务端插件」；
    - 插件版本与扩展版本不一致时提示「服务端插件版本过旧」；
    - 连接 SillyTavern 后端出错时显示错误信息。
  - 非正常状态下，卡片会直接列出带「复制」按钮的修复命令（手机 Termux 的一行命令、电脑在 SillyTavern 文件夹里运行的 `node` 命令）。复制对应的命令运行后重启 SillyTavern，再点卡片右上角的「重新检测」即可。
  - 在 TauriTavern 中，该卡片显示内置同步组件是否可用。
- **连接卡片**：已连接时显示服务器名称、地址和上次同步时间，可点「修改」更换服务器地址或 API Key，或点「断开」解除连接。
- **同步模式与上传/下载**：在「增量」与「镜像」之间切换同步模式，点击上传或下载开始同步。
- **进度条与结果**：上传、下载时显示进度条、已传输大小、速度、剩余时间和当前文件；完成后显示统计结果（文件数、实际传输、删除数、用时）。

### 增量与镜像模式

| 模式 | 行为 |
|---|---|
| 增量 | 仅新增和更新文件，目标端多出的文件予以保留（带冲突保护，见下） |
| 镜像 | 使目标端与源端保持一致，删除目标端多出的文件（上传时删除云端多余文件，下载时删除本地多余文件） |

- **使用建议**：拿不准时就用「**增量**」模式，它只会添加和更新文件，不会删除任何东西。只有在你明确希望让云端或另一台设备「跟当前设备完全一样、清理掉多余旧文件」时，才切换到「**镜像**」模式。
- **冲突保护**：每台设备会记住上次同步时每个文件的状态：只有一边改过的文件正常同步；对方比本机新的文件（上传时云端较新、下载时本机较新）会跳过，不会用旧版本覆盖新版本；两边都改过的文件判为冲突并跳过。设备第一次同步（还没有记录）时，按文件修改时间较新的一方为准。跳过的文件会在结果卡片中列出（原因：云端较新 / 本机较新 / 两边都改过），并提供「以本机为准强制上传」或「以云端为准强制下载」按钮；有文件被跳过时下载完成后不会自动刷新页面，可点「刷新页面载入新数据」。镜像模式仍以操作的一方为准，不做冲突判断。
- **本机备份**：下载时被覆盖或删除的本机文件会先备份到 `data/_stsync/<用户>/trash`，保留 7 天，结果卡片显示备份数量；需要恢复时从该目录手动拷回。
- **保护规则**：镜像模式只删除各类别目录中的文件。`settings.json`、`secrets.json` 等单个文件在源端缺失时不会被删除。`.git`、`node_modules` 目录以及 STSync 扩展自身（`extensions/stsync`）不参与同步，避免传输扩展的 git 仓库、损坏 git 数据或让不同设备的 STSync 互相降级；Luker 聊天旁的附属文件（`*.luker-state.*.json`，如记忆图谱）只有在对应聊天也被删除时才会被镜像模式删除，原版 SillyTavern 设备做镜像上传不会删掉它们。酒馆自动生成的备份目录 `data/default-user/backups`（聊天与设置的自动备份）默认不同步：不会上传、不会下载，镜像模式也不会删除任何一边已有的备份；STSync 自己的回收站（本机 `data/_stsync`、服务器 `/srv/stsync/state/trash`）同样不同步。TauriTavern 设备也同样排除其 `backups` 数据集。

### 多设备同步推荐流程

1. **首次汇总**：在主力设备上用「增量」模式点一次「上传」，把数据传到云端；如果有其他设备也有独立角色卡或聊天记录，同样用「增量」上传合并到云端，最后在各设备点一次「下载」。
2. **日常切换设备**：
   - 开始使用某台设备前，先点「**下载**」拉取最新数据；
   - 用完准备换设备前，点「**上传**」把新聊天和改动推上云端。
3. **锁定新设备接入**：所有常用设备都配对连接好之后，建议在服务器上运行 `stsync lock` 关闭新设备接入。这样已连接的设备照常同步，别人就算拿到了 API Key 也无法接入。

即使忘了先下载就上传，冲突保护也会跳过云端较新的文件，按结果卡片提示先下载再上传即可。

## 常见问题

| 现象 | 解决办法 |
|---|---|
| 连接时提示超时、连不上 | 检查云服务器的「安全组 / 防火墙」是否放行了 TCP 8443 端口 |
| 提示「API Key 无效」或「已关闭新设备接入」 | 在服务器上运行 `stsync unlock 30`，30 分钟内重新连接 |
| 提示「本机时间与服务器相差超过 2 分钟」 | 把电脑的系统时间设为自动同步 |
| 面板提示「未检测到服务端插件」或「服务端插件版本过旧」 | 复制面板「后端检测」卡片中给出的修复命令运行（手机在 Termux 运行一行命令，电脑在 SillyTavern 文件夹下运行 `node` 命令），重启 SillyTavern 后点击面板上的「重新检测」 |
| 忘了服务器地址或 API Key | 在服务器上运行 `stsync key` |
| 在 Luker 上运行一行安装命令提示找不到 SillyTavern | 更新到最新版安装脚本，已支持识别 Luker；仍找不到时把 Luker 目录写在命令最后：`... \| sh -s -- ~/Luker` |
| 面板提示「未识别的酒馆」 | 说明你用的是 SillyTavern / Luker 以外的分支，STSync 未在上面验证过。先备份 data 目录，用增量模式试同步几项数据，确认正常后再日常使用 |
| 上传/下载后提示「已跳过 N 个文件」 | 这些文件对方更新或两边都改过，为避免覆盖已跳过。通常先做相反方向的同步（上传前先下载、下载前先上传）；确认要以某一边为准时点结果卡片里的强制按钮 |
| 提示「这个设备 ID 已被另一台设备使用」 | 服务器上已有同 ID 的设备但密钥不同（例如复制了另一台设备的数据目录）。在服务器上用 `stsync revoke` 断开旧设备后重新连接 |

## 升级与卸载

### 升级

- **服务端升级**：在服务器上再次运行同一条安装命令即可升级，原有的端口、地址、API Key 和数据都会保留：

  ```sh
  curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/install.sh | sudo sh
  ```

  重复运行会检测已完成的步骤并自动跳过（基础工具齐全、Node.js 已满足要求、引擎文件无变化、`tt-sync` 版本一致、服务运行中且配置无变化时不重启服务），结尾会列出本次跳过的步骤。
- **SillyTavern 端升级**：服务端插件的代码位于扩展目录中，在 SillyTavern 扩展页更新 STSync 后，重启 SillyTavern 即可同时更新插件。Termux / Linux / macOS 也可以再次运行 `curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/st-install.sh | sh` 完成更新。
- **TauriTavern 端升级**：直接在扩展页更新 STSync 即可。

### 卸载

#### 服务端卸载

在服务器上运行：

```sh
curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/uninstall.sh | sudo sh
```

也可直接运行 `stsync uninstall`（管理面板菜单里也有「u) 卸载 STSync」）。卸载会停止并删除 `stsync`、`stsync-tauritavern` 服务和自动关闭接入的定时器，移除防火墙放行规则和限速规则，删除 `/opt/stsync`、`/usr/local/sbin/stsync`、`/srv/stsync`（包括全部云端数据、API Key、服务器证书）以及系统用户 `stsync`。

执行前会列出要删除的内容并要求输入 `yes` 确认；加 `--yes`（例如 `... | sudo sh -s -- --yes`）则不询问。数据删除后无法恢复，需要保留请先备份 `/srv/stsync/workspace`。如果使用了共用数据模式，酒馆的数据目录不会被删除。卸载后可在云服务器控制台的安全组里关闭对应端口。

#### SillyTavern 端卸载

- **Termux / Linux / macOS**：

  ```sh
  curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/st-uninstall.sh | sh
  ```

  找不到时把路径写在最后：`... | sh -s -- ~/SillyTavern`，加 `--yes` 不询问。删除 `plugins/stsync`、`data/default-user/extensions/stsync`、`data/_stsync`（本机的配对身份和同步缓存），本机的角色卡、聊天等数据和云端数据都不受影响；如果 `enableServerPlugins` 是安装时由 STSync 打开的，且没有其他服务端插件，会把它恢复为 `false`。重启 SillyTavern 后生效。
- **Windows 电脑**：关闭 SillyTavern 后手动删除上面三个文件夹即可。

#### TauriTavern 端卸载

在扩展页删除 STSync 扩展即可。

## 与服务器上的酒馆共用数据（如 Luker）

- **适用场景**：服务器上本身就运行着一个 SillyTavern 或 Luker，希望它和其他设备共用同一份数据：其他设备上传后服务器上的酒馆立即可见，在服务器酒馆里的改动其他设备直接下载即可，服务器上的酒馆不需要安装 STSync 插件。
- **用法**：

  ```sh
  curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/install.sh | sudo sh -s -- --workspace /luker
  ```

  把 `/luker` 换成酒馆所在目录；已安装过的服务器重新运行这条命令即可切换，之后升级不必再带 `--workspace`。
- **脚本会做什么**：校验目录（需包含 `server.js` 和 `data/`）；STSync 与 `tt-sync` 两个服务改为以该酒馆 `data` 目录的属主身份运行（Luker 一般是 `sillytavern`），只对 `data/` 和 `public/scripts/extensions/third-party` 有写权限，酒馆的程序代码保持只读；TauriTavern 设备也同步到这份数据。原先 `/srv/stsync/workspace` 中的云端数据不会被删除或合并。
- **回收站**：共用模式下，SillyTavern / Luker 设备上传时被覆盖或删除的旧文件会先放进回收站 `/srv/stsync/state/trash`，保留 7 天后自动清理；用 `stsync trash` 查看批次，`stsync trash <批次>` 查看文件并按提示用 `cp -a` 恢复。TauriTavern 设备的写入经由 `tt-sync`，不经过回收站。
- **注意事项**：
  - 服务器上的酒馆正在使用时，尽量不要同时从其他设备上传；
  - 其他设备上传后，刷新服务器酒馆的网页即可看到新数据；
  - 镜像上传会删除服务器酒馆中多出的文件（旧文件进回收站）；
  - 建议切换前先备份酒馆的 `data` 目录，例如 `tar -czf /root/luker-data-backup.tar.gz -C /luker data`；
  - 卸载 STSync 时，共用的酒馆数据会保留、不做任何改动。

## 服务器管理

### 管理面板 `stsync`

在服务器上以 `root` 运行 `stsync` 可打开交互式管理菜单，也可直接通过子命令调用：

| 菜单编号 | 命令 | 说明 |
|---|---|---|
| — | `stsync` | 打开交互式管理面板 |
| — | `stsync status` | 查看服务状态、对外地址、监听端口、已接入设备数与云端数据大小（共用模式下显示共用的酒馆目录与运行身份） |
| 1 | `stsync key` | 显示服务器地址与 API Key |
| 2 | `stsync rotate` | 更换 API Key，旧 Key 立即失效（已连接设备不受影响） |
| 3 | `stsync devices` | 列出已接入的设备（含 SillyTavern / Luker 与 TauriTavern 设备） |
| 4 | `stsync revoke <设备>` | 按设备 ID 或名称断开指定设备 |
| 5 | `stsync lock` / `stsync unlock [分钟]` | 关闭或开启新设备接入；指定分钟数后到时自动关闭 |
| 6 | `stsync port <端口>` | 修改对外端口，更新 ufw 放行与限速规则并重启服务 |
| 7 | `stsync host <IP/域名>` | 修改对外地址 |
| 8 | `stsync restart` | 重启服务 |
| 9 | `stsync logs [行数]` | 查看服务日志（默认最近 50 行） |
| t | `stsync trash [批次]` | 查看回收站（共用数据模式下被覆盖或删除的旧文件保留 7 天） |
| — | `stsync firewall` | 重新应用防火墙放行与限速规则 |
| u | `stsync uninstall` | 卸载 STSync（删除服务、程序和全部云端数据） |

修改端口或对外地址后，API Key 保持不变；已连接的设备需在前端扩展面板中点击「修改」，填入新地址后重新连接。

### 服务器文件位置

| 路径 | 用途 |
|---|---|
| `/opt/stsync/node` | 独立安装的 Node.js 24（`v24.22.3`），或指向满足要求的系统 Node.js 的链接 |
| `/opt/stsync/engine` | STSync 同步引擎代码 |
| `/opt/stsync/tt-sync` | 官方 `tt-sync` 二进制程序（`2.6.0`） |
| `/srv/stsync/workspace` | 云端数据工作区，目录结构与 SillyTavern 安装目录一致 |
| `/srv/stsync/state` | 服务器身份、TLS 证书、已接入设备、文件索引与块仓库 |
| `/srv/stsync/state/trash` | 回收站（仅共用数据模式） |
| `/srv/stsync/tauritavern` | TauriTavern 兼容组件（`tt-sync`）配置与状态目录 |
| `/srv/stsync/config.json` | 监听地址、对外地址、工作区路径与 TauriTavern 兼容配置 |
| `/srv/stsync/apikey` | API Key 令牌文件 |

## 进阶安装

### SillyTavern 安装详情

服务端插件需要 **Node 18 以上**环境（依赖 Node 内置的 ed25519 与 `X509Certificate`）。

- **一行安装（Termux / Linux / macOS）**：

  ```sh
  curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/st-install.sh | sh
  ```

  脚本自动查找 SillyTavern（当前目录、`~/SillyTavern`，以及主目录下两层以内），用 git 安装或更新扩展，再运行插件安装脚本（Termux 上缺少 `git` 或 `nodejs` 时会自动用 `pkg` 安装）；重复运行会自动跳过已完成的步骤（扩展已是最新、插件已安装、配置已开启时都跳过，全部就绪时提示无需重启）。找不到时可把路径写在最后：`... | sh -s -- ~/SillyTavern`。
- **手动安装**：
  1. **前端扩展**：在 SillyTavern 扩展页「安装扩展」中填入 `https://github.com/lingyidaze/stsync`，安装到 `data/default-user/extensions/stsync`。
  2. **服务端插件**：在 SillyTavern 根目录运行 `node data/default-user/extensions/stsync/st-plugin/install.mjs`。它会在 `plugins/stsync` 写入一个指向扩展目录中插件代码的入口，并在 `config.yaml` 中开启 `enableServerPlugins: true`（原文件备份为 `config.yaml.bak-stsync`）。
  3. 重启 SillyTavern。

其他基于 SillyTavern 的分支不会被自动识别；可把目录写在命令最后手动指定（`... | sh -s -- ~/MyTavern` 或 `node .../install.mjs ~/MyTavern`），脚本会给出提示后按 SillyTavern 的方式安装。

### TauriTavern 安装详情

在扩展页通过 Git 地址 `https://github.com/lingyidaze/stsync` 安装。在 TauriTavern 环境下，前端扩展直接调用宿主内置的同步接口，无需安装服务端插件。

### 服务端 `install.sh` 参数与执行步骤

支持 Debian / Ubuntu 系统，需使用 `root` 权限执行：

```sh
curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/install.sh | sudo sh
```

需要指定参数时写在 `sh -s --` 后面，例如：

```sh
curl -fsSL https://raw.githubusercontent.com/lingyidaze/stsync/main/install.sh | sudo sh -s -- --port 9443
```

可选参数：

- `--port <端口>`：指定对外监听端口（默认 `8443`）。
- `--host <IP或域名>`：指定对外公网地址（未指定时自动探测公网 IPv4）。
- `--workspace <目录>`：直接使用服务器上某个 SillyTavern / Luker 的数据目录（见上方章节）。
- `--no-tauritavern`：跳过安装 TauriTavern 兼容组件。

`install.sh` 按顺序完成以下操作（在仓库目录外运行时会先下载最新代码）：

1. 准备 Node.js（需要 ≥ `v22.15.0`）：若 `/opt/stsync` 中已有满足要求的 Node 则跳过；若系统自带 `node`（不在 `/root`、`/home` 下）版本满足要求则直接复用，不再下载；否则下载官方 `v24.22.3` 发行包并校验 SHA256，安装至 `/opt/stsync/node`。
2. 安装 STSync 同步引擎至 `/opt/stsync/engine`，初始化工作区并生成自签 TLS 证书。
3. 下载官方 `tt-sync` 发行包（`2.6.0`）并校验 SHA256，安装至 `/opt/stsync/tt-sync`，配置其仅监听 `127.0.0.1:18443`（指定 `--no-tauritavern` 时跳过）。
4. 创建系统用户 `stsync`，注册并启动 `stsync.service` 与 `stsync-tauritavern.service`。
5. 若检测到启用中的 ufw，放行对外端口并配置新建连接限速规则，最后输出服务器地址与 API Key。

## 安全

- **API Key 与接入控制**：
  - API Key 格式为 `sts1.<令牌>.<证书指纹>`。
  - 新设备接入开启时，持有 API Key 的客户端可登记新设备并读写全部云端数据。
  - 执行 `stsync lock` 关闭新设备接入后，API Key 无法再用于接入新设备，已连接设备继续正常同步。
  - 若 Key 发生泄露，可执行 `stsync rotate` 更换 Key，并通过 `stsync revoke` 断开可疑设备。
- **传输与设备认证**：
  - 服务端使用 TLS 1.3 自签证书，证书 SPKI 指纹编码于 API Key 中。客户端在建立连接时执行证书固定校验，校验通过前不发送任何数据。
  - 设备登记 ed25519 公钥后，每次会话通过设备私钥签名验证：时间窗为 ±2 分钟，随机数不可重复，签名覆盖 `STSYNC-SESSION-1`、设备 ID、时间戳、随机数与请求体哈希。
  - 前端扩展不持久化保存 API Key。
- **连接限速**：若服务端启用了 ufw，系统按来源 IP 对同步端口的新建 TCP 连接实施限速，持续速率限制为每分钟 30 次、突发上限 60 次。
- **连接超时与设备防覆盖**：服务端对空闲连接 5 分钟、单个请求 30 分钟设有超时，并限制最多 512 个并发连接；已接入的设备 ID 不能被另一把密钥重新接入覆盖。
- **服务隔离与数据存储**：
  - `stsync.service` 与 `stsync-tauritavern.service` 均以非 root 用户 `stsync` 运行，仅对各自数据目录及工作区拥有写权限，并启用 systemd 进程隔离、系统调用过滤、设备禁用与资源配额。
  - 云端工作区文件以明文存储于服务器磁盘，不提供端到端加密。

## 工作原理

### 仓库组成

| 路径 | 作用 |
|---|---|
| 根目录（`index.js`、`api.js`、`host-st.js`、`host-tauri.js`、`style.css`、`manifest.json`） | 前端扩展，同时适配 SillyTavern、Luker 与 TauriTavern |
| `st-plugin/` | SillyTavern / Luker 服务端插件，负责本地文件扫描、分块、上传与下载；`install.mjs` 为一键安装脚本 |
| `engine/` | STSync 同步引擎（服务端主程序） |
| `install.sh` | 服务端安装 / 升级脚本（一个文件完成全部部署，含 systemd 服务配置） |
| `st-install.sh` | SillyTavern 端一行安装 / 更新脚本（Termux / Linux / macOS） |
| `uninstall.sh` | 服务端卸载脚本 |
| `st-uninstall.sh` | SillyTavern 端卸载脚本（Termux / Linux / macOS） |
| `server/stsync` | 服务端管理面板 |
| `LICENSE` / `THIRD_PARTY_NOTICES.md` | 本项目许可证与第三方项目声明 |

### STSync 同步协议（`/api/v1`，SillyTavern 使用）

- **数据模型**：
  - 云端工作区采用与 SillyTavern 安装目录相同的布局，文件相对路径与本地一致（如 `data/default-user/chats/…`）。
  - 数据按 `categories.mjs` 中定义的类别划分管理范围；不属于任何类别的文件（例如 TauriTavern 专有数据）不会被读取、覆盖或删除。
- **内容定义分块与指纹**：
  - 采用 FastCDC 算法对文件进行内容定义分块，块大小范围 16–256 KB，平均块大小约 64 KB。
  - 文件指纹定义为 `sha256(文件大小 + 各块 ID)`。客户端与服务端均按文件大小和修改时间缓存索引，未变更的文件不重复读取计算。
- **上传流程**：
  1. 根据本地文件指纹生成同步计划；
  2. 向服务器查询缺失的数据块，仅上传缺失块；
  3. 服务器按块清单拼装目标文件；
  4. 提交变更（镜像模式下于此阶段清理目标端多余文件）。
- **下载流程**：
  1. 服务端在同步计划中返回云端文件的块清单；
  2. 客户端优先复用本地已有文件中的数据块，仅从服务器下载缺失块；
  3. 在暂存区拼装文件并校验完整后原子写入目标路径。
- **断点续传与压缩**：
  - 服务端块仓库中的块保留 7 天（超期自动清理），客户端已下载的块缓存于 `data/_stsync/<用户>/chunks`，重试时均自动跳过。
  - 数据块按批次传输，默认启用 zstd 压缩（不支持时使用 brotli），每个块均执行哈希校验。

### TauriTavern 兼容

- **请求转发与数据共用**：STSync 引擎接收 TauriTavern 的 `/v2/…` 请求后原样转发至本机 `127.0.0.1:18443` 上运行的官方 `tt-sync` 程序。`tt-sync` 以 SillyTavern 目录布局读写同一工作区 `/srv/stsync/workspace`。
- **新设备配对**：客户端提交 `/v2/pair/complete` 请求时，STSync 先校验 API Key 与新设备接入开关，通过后调用 `tt-sync` 命令行生成一次性配对令牌再转发请求，使 TauriTavern 与 SillyTavern 共用同一个服务器地址与 API Key。
- **设置互通**：
  - TauriTavern 将设置拆分为 `settings.json` 与 `settings/` 下的分区文件，SillyTavern 使用完整的 `settings.json`。
  - SillyTavern 下载时若云端 `settings.json` 缺少对应分区字段，插件会自动将 `settings/` 下的分区文件合并写入本地 `settings.json`（分区合并规则移植自 TauriTavern 源码）；SillyTavern 上传完整 `settings.json`，TauriTavern 启动时自行读取拆分。
- **TauriTavern 宿主接口调用**：
  - 前端扩展通过宿主命令 `tt_sync_pair`、`tt_sync_list_servers`、`tt_sync_remove_server`、`tt_sync_push`、`tt_sync_pull`、`sync_get_dataset_catalog`、`lan_sync_get_status` 执行同步与配置管理。
  - 调用 `/scripts/tauri/setting/setting-panel/sync-listeners.js` 中的 `showSyncReportResult` 展示同步报告。

## 致谢与出处

- **[TauriTavern](https://github.com/Darkatse/TauriTavern)**（作者 Darkatse，AGPL-3.0 许可证）：TauriTavern 端调用其内置同步接口；`st-plugin/lib/settings-sections.mjs` 中的设置分区规则移植自其源码 `src-tauri/crates/tt-adapter-storage-core/src/repositories/file_settings_repository/fields.rs`。
- **[TT-Sync](https://github.com/Darkatse/TT-Sync)**（作者 C.J. Wu，MIT 许可证）：TauriTavern 兼容组件，由 `install.sh` 从官方发行页下载并校验 SHA256 后原样运行，不做修改；本仓库不包含 TT-Sync 的代码。
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**（AGPL-3.0 许可证）：STSync 的宿主平台，前端扩展与服务端插件基于其扩展与插件接口开发。
- **[Luker](https://github.com/funnycups/Luker)**（AGPL-3.0 许可证）：SillyTavern 的分支，STSync 的适配对象之一；本仓库不包含 Luker 的代码。

各上游项目的版权声明与完整许可文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

STSync 以 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）发布。

Copyright (C) 2026 lingyidaze
