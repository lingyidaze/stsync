# 第三方声明（Third-Party Notices）

STSync 依赖或参考了下列开源项目。本文件按各项目许可证的要求附上其版权声明与许可文本。STSync 为第三方项目，与下列项目的官方团队无隶属关系。

---

## TT-Sync

- 项目地址：https://github.com/Darkatse/TT-Sync
- 许可证：MIT
- 与 STSync 的关系：
  - TT-Sync 是 STSync 的 TauriTavern 兼容组件。`install.sh` 在部署时从 TT-Sync 的 GitHub Releases 下载官方 `tt-sync` 程序并校验 SHA256，作为独立进程原样运行，不做修改。
  - STSync 引擎只把 TauriTavern 的请求转发给它，并调用它的命令行生成配对令牌、管理设备。
  - 本仓库不包含、不修改、不转发 TT-Sync 的源码或程序。

TT-Sync 的许可文本如下：

```
MIT License

Copyright (c) 2026 C.J. Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## TauriTavern

- 项目地址：https://github.com/Darkatse/TauriTavern
- 作者：Darkatse
- 许可证：GNU Affero General Public License v3.0（AGPL-3.0）
- 与 STSync 的关系：
  - `st-plugin/lib/settings-sections.mjs` 中的设置分区规则移植自 TauriTavern 源码 `src-tauri/crates/tt-adapter-storage-core/src/repositories/file_settings_repository/fields.rs`。
  - 在 TauriTavern 上运行时，STSync 调用 TauriTavern 内置的 TT-Sync 客户端接口。

STSync 以 AGPL-3.0 发布，许可全文见仓库根目录的 [LICENSE](LICENSE)。

---

## SillyTavern

- 项目地址：https://github.com/SillyTavern/SillyTavern
- 许可证：GNU Affero General Public License v3.0（AGPL-3.0）
- 与 STSync 的关系：STSync 是 SillyTavern 的扩展与服务端插件，基于 SillyTavern 的扩展和插件接口开发，不包含 SillyTavern 的源码。

---

## Luker

- 项目地址：https://github.com/funnycups/Luker
- 许可证：GNU Affero General Public License v3.0（AGPL-3.0）
- 与 STSync 的关系：STSync 的适配对象之一（识别 Luker 安装目录、同步其专属数据目录 card-apps 与 skills、保护其聊天附属文件），本仓库不包含 Luker 的代码。
