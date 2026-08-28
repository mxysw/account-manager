# Account Manager（本机浏览器版）

一个本地自托管的 Google 账号管理与浏览器自动化面板。它可以批量导入账号、生成 TOTP 验证码、记录检测状态、自动分类，并使用本机 Chrome 或 Edge 执行登录、检测和维护流程。

> 当前研发重点是“本机临时浏览器”模式。AdsPower 兼容代码仍然保留，但暂不作为维护、测试和文档重点。

## 功能概览

- 本地 JSON 存储，不依赖数据库服务。
- 批量导入账号，按邮箱去重，重复导入只补全空字段。
- 自动填写邮箱、密码和 TOTP；遇到验证码、短信验证、安全密钥或高风险验证时停止并提示人工处理。
- 每个并发槽启动独立的一次性 Chrome/Edge 配置，任务结束后默认关闭并清理。
- 检测结果逐项写回账号库，可归入养号、废号、登录失败、待人工、密钥错误、出售和已售等视图。
- 支持单账号运行和批量运行；行内“检测”会复用批量操作面板的当前配置。
- 内置 Gmail/YouTube 封禁、服务限制、地区、GPT、Gemini 等检测，以及语言、2FA、设备、验证电话、年龄和支付资料等维护动作。

## 环境要求

- Windows 10/11。
- Node.js 22.12.0 或更高版本。
- npm。
- Google Chrome；找不到 Chrome 时会自动尝试 Microsoft Edge。
- 可以访问动作所需的网站。

本机模式不需要安装或启动 AdsPower，也不需要 AdsPower API Key。

## 安装与启动

~~~powershell
git clone https://github.com/mxysw/account-manager.git
cd account-manager
npm ci
npm start
~~~

启动成功后打开：

~~~text
http://127.0.0.1:8910
~~~

开发时可以使用自动重启：

~~~powershell
npm run dev
~~~

如果 Chrome/Edge 不在常见安装位置，请在启动服务前指定浏览器路径：

~~~powershell
$env:LOCAL_BROWSER_PATH = 'D:\Apps\Chrome\chrome.exe'
npm start
~~~

端口被占用时可以临时更换：

~~~powershell
$env:PORT = '8911'
npm start
~~~

除非你已经自行增加认证和网络隔离，否则不要把 `HOST` 改为 `0.0.0.0`。默认的 `127.0.0.1` 只允许本机访问。

## 导入账号

进入“检测系统” → “导入账号”，每行粘贴一个账号。前两项固定为邮箱和密码，后续字段会自动识别。

使用 `|` 分隔：

~~~text
user@example.com|password|BASE32_TOTP_SECRET|2025|US
~~~

使用 `----` 分隔：

~~~text
user@example.com----password----recovery@example.com----BASE32_TOTP_SECRET----2025----US
~~~

导入规则：

- 至少需要“邮箱 + 密码”。
- 后续字段顺序可以变化：包含 `@` 的字段识别为辅助邮箱；四位年份识别为注册年份；Base32 字符串识别为 TOTP 密钥；短英文字符串识别为国家或地区。
- 辅助邮箱为空时可以写 `空` 或 `?`。
- TOTP 密钥中的空格和连字符会自动移除。
- 邮箱去重不区分大小写；重复导入不会覆盖已有值，只补全空字段。
- “货源渠道 / 标签”会写入本批新账号，旧账号仅在该字段为空时补入。

示例均为占位符。不要把真实凭据写进 README、Issue 或 Git 提交记录。

## 使用本机浏览器模式

第一次使用时，建议只用一个你自己拥有的测试账号：

1. 在“检测系统”导入账号，确认邮箱、密码和 TOTP 密钥齐全。
2. 展开顶部“批量操作（本机浏览器优先）”。
3. 选择“本机临时浏览器（推荐，用完即弃）”。新安装默认就是该模式。
4. 把并发数设为 `1`，稳定后再逐步增加。每个并发槽都会启动一个独立浏览器进程。
5. 勾选账号，再按执行顺序勾选动作。本机浏览器没有历史登录态，通常应先选“登录账号”，再选检测或维护动作。
6. 点击“对选中账号运行”。只运行一行时，可以点击该账号行内的“检测”。
7. 在运行日志中查看结果；每个动作完成后，状态会立即写回账号库。
8. 需要中断时点击“停止并关闭窗口”。
9. 检测完成后可使用“一键分类”把账号归入对应管理视图。

推荐的首次验证顺序：

1. 单账号、并发 `1`、仅运行“登录账号”。
2. 登录稳定后，增加 Gmail/YouTube 封禁、服务限制、地区等低风险检测。
3. 最后再单独验证改语言、换 2FA、移除设备/电话、年龄验证或关闭支付资料等写操作。

### 本机模式的行为

- 自动优先查找 Chrome，找不到时回退到 Edge；可以用 `LOCAL_BROWSER_PATH` 覆盖。
- 每个账号任务使用新的临时用户数据目录，通常位于 `%TEMP%\am-local-*`。
- 默认在任务结束后关闭浏览器并删除临时目录。
- 勾选“跑完不关闭窗口”时，程序只断开自动化连接，浏览器和临时目录会保留供人工检查。检查后请手动关闭窗口，并清理不再需要的 `%TEMP%\am-local-*` 目录。
- 本机模式暂未在界面中接入代理，当前按直连使用。
- 本机模式不使用 AdsPower 环境编号或 AdsPower 随机指纹。

## 账号管理流程

- “检测系统”：导入、编辑、运行检测和一键分类。
- “养号管理”：保存状态正常但尚未达到出售标准的账号。
- “废号管理”：收纳 Gmail、YouTube 或 GPT 已封禁的账号。
- “登录失败 / 待人工 / 密钥错误”：分别处理密码失败、额外验证和 TOTP 异常。
- “出售管理”：集中处理待交付账号，导出时可标记已售。
- “已售记录”：查询已交付账号，并支持误操作后退回在库。

复制或导出账号时会把凭据放入系统剪贴板，使用完毕后请及时清理剪贴板。

## 数据文件与备份

运行数据保存在：

~~~text
data/accounts.json   账号、密码、TOTP、辅助邮箱、状态和备注
data/cards.json      卡号、有效期、CVC 和使用状态
data/cookies.json    已保存的会话 Cookie（如有）
~~~

这些文件包含敏感信息，已被 `.gitignore` 排除。GitHub 只备份代码，不会、也不应该备份真实运行数据。

备份前先在运行服务的终端按 `Ctrl+C` 正常退出，然后在项目目录执行：

~~~powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Split-Path $PWD -Parent) "account-manager-data-$stamp"
Copy-Item -LiteralPath '.\data' -Destination $backupDir -Recurse
Write-Host "已备份到 $backupDir"
~~~

恢复时先停止服务，并先保留当前数据，再把备份中的 JSON 文件复制回 `data/` 后重新启动。

前端选择、筛选和运行模式等偏好保存在浏览器 `localStorage` 中；任务队列和运行日志只存在于当前服务进程内，不包含在上述数据备份中。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `8910` | HTTP 服务端口 |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `LOCAL_BROWSER_PATH` | 自动查找 | 指定 Chrome/Edge 可执行文件 |
| `ACCOUNT_MANAGER_DATA_DIR` | 项目内 `data/` | 指定运行数据目录，测试和隔离部署时使用 |

## 开发与测试

~~~powershell
npm start      # 启动服务
npm run dev    # Node watch 模式
npm test       # 使用一次性临时数据目录运行测试
~~~

项目没有前端构建步骤，浏览器直接加载 `public/` 下的 HTML、CSS 和 JavaScript。

主要目录：

~~~text
src/
  server.js                 HTTP 入口
  router.js                 API 与静态资源路由
  accounts.js               账号服务、状态和分类
  cards.js                  卡池
  cookies.js                Cookie 存储
  totp.js                   TOTP 生成
  automation/
    local-browser.js        本机 Chrome/Edge 启动器
    browser.js              Puppeteer CDP 会话
    engine.js               并发任务引擎
    actions/                自动化动作
public/                     单页管理界面
test/run.js                 确定性测试
tools/                       本地调试工具
~~~

新增动作需在 `src/automation/actions/index.js` 注册。动作统一返回 `outcome`，并可以通过 `statusPatch` 或 `fieldPatch` 把结果写回账号库。

## 常见问题

### PowerShell 提示找不到 `node` 或 `npm`

安装 Node.js 22.12+，重新打开 PowerShell，然后检查：

~~~powershell
node --version
npm --version
~~~

### 提示“未找到本机浏览器”

安装 Chrome/Edge，或在启动服务前设置 `LOCAL_BROWSER_PATH`。路径必须指向浏览器可执行文件，而不是快捷方式。

### 提示“未安装 puppeteer-core”

不要使用 `--omit=optional`，然后重新安装依赖：

~~~powershell
npm ci
npm ls puppeteer-core
~~~

### 浏览器打开了，但没有自动登录

本机模式使用全新临时配置，没有历史登录态。请确认勾选了“登录账号”，并确认账号有邮箱、密码和有效的 Base32 TOTP 密钥。

### 登录显示“待人工”或“2FA 密钥错”

短信验证、Google Prompt、安全密钥、验证码或可疑活动验证会按设计停止。需要查看现场时，可在运行前勾选“跑完不关闭窗口”。“2FA 密钥错”应先人工核对密钥和系统时间。

### 浏览器跑完自动关闭

这是默认行为。需要保留现场时，在运行前勾选“跑完不关闭窗口”。保留后请自行关闭窗口，并清理不再需要的 `%TEMP%\am-local-*` 目录。

### 服务重启后任务不见了

任务队列和日志保存在内存中，服务重启后会丢失；已经完成的动作状态会逐项写回 `data/accounts.json`。

### 本机模式如何配置代理

界面目前尚未接入本机代理配置，因此本机模式暂按直连使用。AdsPower 代理池选项不适用于本机模式。

## 安全提示

- 只操作你本人拥有或明确获授权管理的账号。
- 服务没有登录认证；保持监听 `127.0.0.1`，不要直接暴露到局域网或公网。
- 账号密码、TOTP、Cookie 和卡片信息目前均为本机明文存储。不要在共享电脑上运行，建议使用磁盘加密和受控的离线备份。
- 不要提交 `data/*.json`、页面转储、截图、日志、备份目录或 `.env`。
- 自动登录和并发访问可能触发风控。先从并发 `1` 开始，遇到验证码或额外验证时改为人工处理，不要持续重试。
- 换 2FA、移除设备/电话、年龄验证和关闭支付资料属于高风险写操作，可能不可逆；执行前请备份数据并确认账号恢复手段。

## AdsPower 说明

仓库暂时保留 AdsPower 兼容实现，便于后续恢复或迁移。当前版本以本机 Chrome/Edge 模式为主要研发目标，AdsPower 模式暂不维护，也不保证已通过最新环境验证。
