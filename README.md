# TycGame · HTML Publisher

一个完整运行在 **GitHub Pages** 上的 HTML 与静态 Web APP 发布器。网站首页就是发布器，可直接选择文件、管理应用并打开运行；没有站外跳转，不需要另外部署服务器。

默认网站地址：**https://tycofficial.github.io/tycgame/**。如果仓库名改为 `TycGame`，请使用 GitHub Pages 设置页提供的相应地址。所有资源采用相对路径，兼容仓库子路径。

## 两种存储方式

| 方式 | 保存位置 | 换设备访问 | 连接要求 |
| --- | --- | --- | --- |
| 本地体验 | 当前浏览器 IndexedDB | 不会自动同步 | 无需账号，可立即使用 |
| GitHub 云端 | 所选仓库的独立 `tycgame-data` 数据分支 | 连接同一个仓库即可读取 | GitHub 仓库访问令牌；公开应用运行可匿名读取 |

本地体验与云端模式在界面中明确区分，不会把浏览器本地文件显示成已同步到云端。源码保存在 `main`，应用上传到独立数据分支；程序拒绝把默认源码分支用作数据分支。

## 开始使用

1. 打开 GitHub Pages 网站，在本地体验中先试用示例，或选择 HTML、ZIP、文件夹、多文件。
2. 填写应用名，选择 HTML 入口和访问后缀；多文件工程应上传**构建产物**，而非未构建的工程源码。
3. 上传后从应用库打开；应用在独立窗口运行，支持相对资源、ES modules、JSON、Wasm 和浏览器存储。
4. 要跨设备使用，点击连接 GitHub，选择数据仓库并填写访问令牌，再进行云端上传。
5. 暂停或离开后重新选择同一批原始文件，即可续传。云端续传会校验已上传分块的内容，避免同名同大小文件被错误拼接。

### 连接 GitHub

建议使用只授权**目标数据仓库**的 fine-grained personal access token：

- 在 [GitHub 令牌设置](https://github.com/settings/personal-access-tokens/new) 创建令牌，选择仓库所有者和目标仓库。
- Repository permissions 中授予 **Contents: Read and write**，Metadata 保留默认读取；无需授权修改仓库设置或工作流。
- 在发布器连接窗口填写 `owner/repo`、数据分支 `tycgame-data` 以及令牌。令牌只在当前管理标签页和运行器的内存中使用；不写入 URL、Git 提交、localStorage、sessionStorage 或 IndexedDB。刷新后需重新连接。
- 公开仓库中的上传文件是公开的；需要私人文件时请选择有权限写入的**私有数据仓库**。私有数据仓库与托管网站的公开仓库可以不同。

不要在聊天、代码或公开页面中发送令牌。公开仓库的运行链接无需令牌；私有应用需先连接仓库，再从应用库运行。私有运行会话使用内存中的只读文件映射，建议保持管理标签页打开，供浏览器回收 Service Worker 后重建连接。

## 上传与运行

- HTML、文件夹、ZIP、多文件上传；8 MiB 分块，可选择 2 / 4 / 6 路并发。
- 对 GitHub 的写入有节流与限流重试，遇到配额限制时保留已提交的进度，不绕过 GitHub 的限制。
- 每个应用的程序边界为 **2 GiB、2000 文件**。支持 100 MiB 以上 HTML 和 1 GiB 多文件清单；实际保存、上传时长及运行能力还取决于 GitHub 配额、网络、浏览器和设备。未进行 1 GiB 公网传输测速。
- 运行器使用 Service Worker 从分块流式返回资源，支持 Range/HEAD，不先把整个大 HTML 拼成一个字符串。
- 文件夹和 ZIP 会保留目录结构；ZIP 的共同根目录会自动剥除。Vite 等工程推荐 `base: './'`。以根路径 `/assets/...` 构建的应用需要改成相对路径，才能在仓库子路径与独立应用路径下正常运行。
- 可以搜索、筛选、排序、重命名、复制运行链接、下载 HTML/ZIP 和删除应用。支持大 ZIP 流式保存的浏览器会使用文件保存接口；其他浏览器的大文件下载受到内存限制。
- 运行地址类似 `run.html?owner=你的账户&repo=数据仓库&branch=tycgame-data&app=后缀`。通过后缀打开功能无需手工填写参数。
- 还提供 GitHub Pages 的短路径入口：`网站地址/后缀` 或 `网站地址/a/后缀`。它会先查找此浏览器的同名本地应用，再查找默认公开仓库；不同数据仓库可使用完整运行链接或加上 `owner`、`repo`、`branch` 查询参数。短路径路由只发生在本站内。

这是一台**静态应用发布器**：不执行 Node/Python/PHP 后端，也不负责同步上传应用自身的业务数据。没有预设国内专线或测速证明。

## 运行权限与数据边界

上传应用在独立、无 opener 的窗口中运行。管理页把固定文件清单和只读会话直接交给 Service Worker；运行页面和上传应用不接收 GitHub 令牌，不能要求运行器代为访问任意 GitHub API。运行会话只读取批准清单内的分块。

为兼容 modules、fetch 和浏览器存储，应用在本站来源中执行；浏览器 localStorage 与 IndexedDB 仍是共享的。**只运行你信任的应用**，不要把它当作隔离不可信代码的安全容器。GitHub 令牌始终不持久保存。

云端删除会移除当前数据分支的应用清单及不再引用的文件；**Git 历史仍可能保留旧内容**。若曾向公开仓库上传秘密，应立即撤销秘密，并使用 GitHub 的历史清理流程；普通删除不能撤回已公开的数据。

## 开发和验证

需要 Node.js 22+。

```sh
npm ci
npm test
npm run check
npm run dev -- --base /TycGame/
```

本地地址为 `http://127.0.0.1:4173/TycGame/`，可验证与 GitHub Pages 相同的子路径。生产运行不需要 npm 包或 CDN；ZIP 库 fflate 已连同 MIT 许可放在 `assets/vendor/`。

```sh
npm run build
```

生成的 `dist/` 是纯静态网站。GitHub Pages 使用 **Deploy from a branch → main → /(root)** 时，也可直接部署根目录，不需要构建；`.nojekyll` 已包含。上传数据分支无需开启 Pages。

测试覆盖 GitHub REST 协议模拟、分块与续传、并发 Git 引用冲突、源码分支保护、令牌不持久化、IndexedDB、ZIP 路径验证等。真实 Chromium 测试覆盖子路径、手机布局、应用运行和 Service Worker 流式资源；模拟测试不代表 GitHub 公网带宽测速。

## 文件结构

- `index.html` / `assets/styles.css` / `assets/app.js`：完整发布器界面与交互。
- `assets/github-store.js`：GitHub 云存储，独立数据分支与原子 Git 提交。
- `assets/local-store.js`：真实 IndexedDB 本地体验。
- `assets/archive.js`：ZIP 上传及下载。
- `run.html` / `assets/runner.js` / `sw.js`：独立应用运行器与流式虚拟文件服务。
- `tests/`：不依赖外部账号的自动测试。
