# TycGame · HTML 发布器

**[进入 HTML 发布器 →](https://tyc-html-publisher.tyc130923.chatgpt.site)**

上传 HTML 或已经构建好的静态 Web APP，云端保存；在手机、家里电脑、学校机房登录同一个 ChatGPT 账户，即可从主页打开，或使用固定链接运行。网站默认仅所有者可访问，上传文件不会进入这个公开 GitHub 仓库。

## GitHub Pages 发布入口

根目录 `index.html` 与 `.nojekyll` 已准备好，入口名称为 **TycGame**。GitHub Pages 入口会自动打开上方云端发布器，登录、上传及云端文件存储由现有后端提供。

仓库管理者需要首次完成以下设置；当前连接无法修改仓库名称或开启 Pages：

1. 在 **Settings → General → Repository name** 将仓库名称改为 `TycGame`。
2. 在 **Settings → Pages → Build and deployment** 选择 **Deploy from a branch**，分支选择 **main**，目录选择 **/(root)**，点击 **Save**。
3. 等待 GitHub 完成发布，以 Pages 设置页显示的网站地址为准。采用上述仓库名称后，预期入口为 `https://tycofficial.github.io/TycGame/`；未完成设置前此地址尚未验证上线。

以后推送到 `main` 分支时，GitHub Pages 会自动更新入口，无需安装依赖或运行 Worker 构建。请勿将整个发布器后端作为静态页面部署：GitHub Pages 不提供 Worker、认证或 R2 上传 API。

## 使用

1. 打开上方网站，用同一个 ChatGPT 账户登录。
2. 选择单个 HTML、多文件或整个构建输出目录，选择 HTML 入口。手机浏览器对文件夹选择的支持不同，可使用文件多选。
3. 填写名称和可选后缀，开始上传。默认 4 路并发，可选择 2 / 4 / 6；每片 8 MiB，失败自动重试。
4. 上传完成后，从主页打开应用，或访问 `网站地址/a/后缀/`。也可输入 `网站地址/后缀`，网站会自动跳转。
5. 上传中途暂停或关闭页面后，可从应用卡片继续，重新选择同一批原始文件。已完成的分块保存在云端，无需重复传输；换设备继续也需要拿到原文件。

固定链接与登录账户关联，复制链接不会将文件公开给其他账户。清单与文件跨设备同步，上传应用自身的运行数据是否同步取决于应用实现。

## 能力与边界

- 单个应用允许 **2 GiB**、最多 **2,000 个文件**，支持 100 MiB 以上单文件 HTML 和 1 GiB 静态应用的分块传输。实际存储、流量、请求数仍受部署平台及 R2 配额约束。大文件清单与流式响应通过自动检查；没有进行 1 GiB 真实公网测速。
- 大 HTML 从 R2 流式返回，支持 HTTP Range；不会在 Worker 中拼接整个文件。浏览器按自身能力并发加载资源，不会为单个 HTML 强行并行下载后在内存里合并。浏览器能否运行超大 HTML 取决于设备内存和应用代码。
- 支持 HTML/CSS/JS/Wasm、图片、音视频等静态产物。React/Vue/Vite 等工程需先构建，推荐相对路径（例如 Vite `base: './'`）。不运行 Node、Python、PHP、数据库服务或未构建的工程源码。
- 上传内容使用 CSP 安全沙箱，与管理 API 隔离。依赖 `localStorage`、IndexedDB、Service Worker、顶层导航或严格同源权限的应用可能不兼容；私有站点登录也可能影响模块、字体、跨源 fetch 等资源。需要完整浏览器权限时，应部署到独立运行域名，再增加隔离运行网关。当前没有宣称任意 Web APP 都可运行。
- 当前采用部署平台的网络，**没有境内专线或国内节点测速证明**。并发、分块和重试能改善部分网络条件，不保证在所有地区或校园网络可达，不能绕过配额。
- 网站支持运行现成应用；它不是在线代码编辑器。页面中的体验示例也通过真实上传流程写入云端。

## 实现

`ui/index.html` 是单文件前端，`worker/backend.js` 是 Cloudflare Worker 后端。云端身份由 Sites 注入，按用户 ID 隔离；文件及上传会话保存在 R2。小型应用清单也保存在 R2，利用条件写入原子占用后缀，避免额外数据库迁移。每次上传带独立 revision，避免删除后旧请求污染同名新应用。

所有写请求要求同源 Origin 和专用请求头；运行内容无法访问管理 API。私有资源禁止浏览器持久缓存，避免在公共电脑换账户后读取上个账户的缓存。上传分片支持重试、续传、取消和 multipart 清理。删除会移除清单与云端文件；删除后的数据无法恢复。

## 开发与检查

需要 Node.js 22+。

```sh
npm test
npm run build
npm run dev
```

生产代码没有第三方运行依赖。`npm run dev` 通过 Wrangler 4 启动本地 R2，首次运行需要下载 Wrangler。本地开发只在回环地址注入测试身份，数据仅保存在本机；`worker/local.js` 不会打包到线上。

Sites 使用 `.openai/hosting.json` 中的项目身份与 R2 绑定。`npm run build` 将前端内嵌到 `dist/server/index.js`，生成 Worker 发布产物。

自行迁移到 Cloudflare 时，可参考 `wrangler.toml`，创建对应 R2 bucket，并在可信认证网关中验证登录后注入身份。**不能直接公开部署依赖身份请求头的 Worker**：必须保证只有认证网关能设置这些头。GitHub Pages 只能展示静态入口，无法独立提供云端登录、R2 文件保存或上传 API。

## GitHub 与云端数据

这个仓库存放完整源码、测试与部署配置。仓库首页的“进入 HTML 发布器”链接用于打开已部署网站；GitHub 的代码文件页面本身不会执行 HTML。根目录 `index.html` 也是指向当前网站的入口，可用于静态托管。上传的私人 HTML / Web APP 保存在云存储，不作为 Git 提交推送，也不会自动备份到此仓库。
