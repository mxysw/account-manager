# Account Manager 接管文档

更新日期：2026-09-29。本文记录**当前工作目录里的代码状态**，供下一位维护者或 AI 接手；不是对线上账号、AdsPower 客户端或外部服务的实测证明。面向使用者的操作说明见 [README.md](README.md)。本文不包含任何真实账号、密码、2FA 密钥、Cookie、卡号或 API Key。

## 先看当前状态

- 项目是 Windows 上的本地 Node.js/CommonJS 应用。HTTP 服务默认监听 `127.0.0.1:8910`，界面为无构建步骤的 `public/` 单页应用；运行数据使用本地 JSON，不需要数据库服务。
- 本文记录的是 `main` 分支在 2026-09-29 准备推送时的代码快照。接手时先运行 `git status --short` 和 `git log -1 --oneline`，以实际检出的提交与工作区为准；不要重置或覆盖任何后续未提交修改。
- 三种运行模式已在当前代码中出现：本机临时 Chrome/Edge、复用现有 AdsPower 环境、新建 AdsPower 临时环境。最后一种是近期新增功能；**尚未用真实 AdsPower 客户端及账号做端到端验证**。
- `npm test` 是隔离的确定性测试入口；本次文档核对时 **731 项通过**。它不等于真实网站流程已验证。任务队列与任务日志在内存中，服务重启后不能续跑；已经完成并成功落盘的账号/池状态保留。

## 启动与验证

要求 Windows、Node.js `>=22.12.0`、npm；本机模式需要 Chrome 或 Edge。安装后在项目根目录运行：

```powershell
npm ci
npm start
```

打开 `http://127.0.0.1:8910/`。开发时可用 `npm run dev`；回归测试用 `npm test`。可选环境变量：`PORT`、`HOST`、`LOCAL_BROWSER_PATH`、`ACCOUNT_MANAGER_DATA_DIR`，含义见 [README.md 的环境变量章节](README.md#环境变量)。测试入口 [test/run.js](test/run.js) 会先创建一次性数据目录，并设置 `ACCOUNT_MANAGER_DATA_DIR`，不应读取真实 `data/`。不要以真实账号或付费 API 调用代替单元测试。

## 代码地图

| 位置 | 职责 |
|---|---|
| [src/server.js](src/server.js) | HTTP 入口、监听端口、退出时落盘、手机号占用恢复。 |
| [src/router.js](src/router.js) | JSON API、请求校验、静态页面与自动化任务入口。 |
| [src/db.js](src/db.js) | JSON 内存缓存、120 ms 合并写入、临时文件加 `rename` 落盘。 |
| [src/accounts.js](src/accounts.js)、[src/cards.js](src/cards.js)、[src/phones.js](src/phones.js)、[src/cookies.js](src/cookies.js) | 账号、卡池、手机号池、Cookie 的数据模型和状态更新。 |
| [src/totp.js](src/totp.js) | 本地 TOTP 生成。 |
| [src/automation/engine.js](src/automation/engine.js) | 任务调度、并发槽、动作顺序、结果持久化、取消及浏览器收尾。 |
| [src/automation/actions/index.js](src/automation/actions/index.js) | 可用动作注册表、风险等级与互斥规则。各动作实现位于同目录。 |
| [src/automation/browser.js](src/automation/browser.js)、[src/automation/local-browser.js](src/automation/local-browser.js) | CDP 会话、本机浏览器进程和临时用户数据目录。 |
| [src/automation/adspower.js](src/automation/adspower.js)、[src/automation/adspower-temp-ledger.js](src/automation/adspower-temp-ledger.js) | AdsPower Local API 和临时环境所有权台账。 |
| [src/adspower-settings.js](src/adspower-settings.js)、[src/capsolver-settings.js](src/capsolver-settings.js) | 本机 API 设置与 Windows DPAPI 密钥保护。 |
| [public/index.html](public/index.html)、[public/app.js](public/app.js)、[public/styles.css](public/styles.css) | 界面、浏览器端交互和样式；没有前端打包步骤。 |
| [test/run.js](test/run.js)、`test/*.js` | 功能与回归测试。 |

## 用户可见功能

1. **账号库与管理视图**：导入、去重、编辑、删除、复制、导出、状态重置和自动分类；视图包括检测系统、出售、养号、废号、登录失败、待人工、密钥错误、已售。账号行和任务板分别显示持久状态与本次运行进度，不能把“任务已完成”等同于每个动作成功。导入格式、分类含义见 [README.md](README.md)。
2. **辅助数据**：本地 TOTP 取码；卡池；两步验证手机号池（共享/一号一绑、占用、释放、确认绑定）；Cookie 存储模块。`cookie-login.js` 文件仍在，但目前**未注册成可选动作**。
3. **自动化动作**：登录、仅验证密码、Gmail/YouTube 封禁、服务限制、归属地、Cloud 电话验证入口、GPT 授权、Gemini、语言变更、添加/更换身份验证器、移除设备、移除验证电话、添加两步验证电话、年龄验证、年龄验证后关闭支付资料、关闭支付资料。真实可选列表以 [动作注册表](src/automation/actions/index.js) 为准；其中“仅验证密码”“添加身份验证器”“添加两步验证手机号”要求单独运行。涉及账号设置、卡片或手机号的动作是写操作，不能当作无副作用的检测。
4. **任务控制**：可对选中账号运行，也可从单行“检测”使用当前操作面板配置；并发上限由任务引擎限制在 1–20。普通完成、需人工处理与取消分别决定窗口保留/关闭；停止请求会中断当前工作并尝试清理，清理失败应如实显示，不可假报已关闭。
5. **人机及外部配置**：界面有“检测后关闭”“保留窗口”“自动打码后继续并在操作完成后关闭”策略，以及 CAPSOLVER 本机密钥配置。具体适用范围和限制见 [README 的 CAPSOLVER 章节](README.md#capsolver-登录人机验证)。付费任务、网站结果和账号安全步骤均不能仅凭本地提交成功推断完成。

界面的八个视图是“检测系统、养号管理、废号管理、登录失败、待人工、密钥错误、出售管理、已售记录”；部分视图是成员标记，不等同于账号原始检测状态。检测系统支持搜索、分类与状态筛选；管理视图可将账号移入或移出相应列表。账号行提供单行运行、复制、编辑、状态选择、TOTP 取码等操作。卡池可导入、编辑、筛选和管理卡片状态；手机号池可导入、筛选、占用、释放及管理绑定状态。卡号、手机号在界面上应优先脱敏展示。前端主逻辑集中在 [public/app.js](public/app.js)，运行日志面板也在此渲染。

接手改动作时优先使用下面的 ID，而不是仅搜索界面中文标签：

| 类别 | 已注册动作 ID |
|---|---|
| 认证 | `login`、`check-password` |
| 检测 | `detect-ban`、`detect-restrict`、`detect-region`、`detect-cloud-phone`、`detect-gpt`、`gemini-check` |
| 账号设置 | `change-language`、`add-2fa`、`change-2fa`、`remove-devices`、`remove-phones`、`add-2fa-phone` |
| 年龄与支付 | `age-verify`、`age-verify-close`、`close-payment` |

这只是功能索引，不表示所有动作都能无条件成功。每个动作的状态判定和停止条件必须以各自实现及测试为准。

### 三种浏览器模式

| 模式 | 当前实现 | 收尾和边界 |
|---|---|---|
| 本机临时浏览器 `local` | 每个任务启动独立 Chrome/Edge 临时配置；可选最小化；不需要 AdsPower。 | 默认关闭进程并清理临时目录；界面尚未接入本机代理。 |
| 复用现有 AdsPower `adspower` | 用户选择已有环境编号；可配置代理池、清数据及“随机指纹”开关。 | 修改的是**已有环境**，不会把它删除。当前指纹开关存在可靠性问题，见下文，不能据成功提示认定整套指纹已变更。 |
| AdsPower 临时环境 `adspower_temp` | 按任务创建空白环境，记录创建意图与返回的精确 `profile_id`，随后启动并接管。 | 普通结束时先确认关闭，再仅将本任务自建环境移入 AdsPower 回收站；失败则保留供核查，不清空整个回收站。此模式没有接入随机指纹开关、随机系统或代理轮换。 |

AdsPower 连接在界面填写本机地址、端口及 API Key；连接目标限制在本机。临时环境台账 [src/automation/adspower-temp-ledger.js](src/automation/adspower-temp-ledger.js) 保存在 `data/adspower-temp-ledger.json`，用于防止误删已有环境。**不要直接把台账里的 `creating` 记录当作已创建环境，也不要根据名称、备注或列表中的相似项推断所有权。** 当前没有“永久清空 AdsPower 回收站”的代码；用户决定手动处理回收站。保留窗口及停止/关闭的详细状态由 [引擎](src/automation/engine.js) 管理。

## 数据与接口边界

- 默认数据目录为 `data/`，可用 `ACCOUNT_MANAGER_DATA_DIR` 改到隔离目录。主要文件：`accounts.json`、`cards.json`、`phones.json`、`cookies.json`、`capsolver-settings.json`、`adspower-settings.json`、`adspower-temp-ledger.json`。前四类可能包含明文凭据、卡信息、手机号或 Cookie；**只有两个 API Key 设置文件采用当前 Windows 用户的 DPAPI 加密**。整个 `data/*.json` 被 `.gitignore` 排除，但这不是访问控制或备份。
- 部分界面偏好保存在管理页面浏览器的 `localStorage`；任务、任务事件和运行日志仅在当前 Node 进程内。手机号占用有重启恢复逻辑，AdsPower 临时环境有独立的持久台账，但任务本身不会自动恢复。
- API 主要分组在 [src/router.js](src/router.js)：`/api/accounts`、`/api/cards`、`/api/phones`、`/api/settings/{capsolver,adspower}`、`/api/automation/{actions,envs,proxy-tags,run,jobs}`。前端从 [public/app.js](public/app.js) 调用这些接口。修改状态字段时同时核对账号模型、路由响应、前端显示和回归测试。
- 服务默认只绑定回环地址，但**没有通用登录认证**。账号/卡片查询会返回存储记录；同源检查只覆盖部分设置和 AdsPower/打码相关端点。不要把服务暴露到公网、共享网络或不受信任的本机浏览器环境。不要在文档、测试输出、截图、Issue 或提交中放真实凭据。

## 已知限制与待核查点

这些是交接时需要保留的事实，不代表用户已授权执行外部账号操作：

1. **AdsPower 临时模式尚缺真实端到端验证**：现有测试覆盖连接设置、创建/关闭/移入回收站的模拟响应和取消分支，但未证明当前用户客户端、端口及账号场景能完整运行。连接失败时先诊断本机客户端与端口，别用真实账号反复试错。
2. **复用模式的“随机指纹”提示不可靠**：代码的首选请求与目前 AdsPower 的 V2 接口契约不一致；失败后的回退只更新部分配置，其中 UA 固定写成 Windows 形式，可能不匹配环境系统或内核。界面/引擎目前只按接口返回码报成功，没有核实实际变更。新建的临时环境没有“三系统随机选择”功能。不要把这些现状描述为已完成能力。
3. **预登录失败可能污染登录状态**：指纹或浏览器准备阶段报错时，通用异常路径可能在还没访问登录页之前写入“登录失败”。后续维护应将环境错误与账号认证结果区分，避免误导使用者。
4. **JSON 数据层需检查异常边界**：`JsonDB.load()` 在读取/解析失败时会回退初始结构，可能掩盖损坏；`flushSync()` 对尚未加载的实例直接写入值得专项验证。处理前先备份真实 `data/`，只在隔离测试目录复现。
5. **运行能力边界**：本机代理仍是预留字段、没有 UI；临时 AdsPower 模式无代理轮换、无随机指纹、无永久删除回收站；CAPSOLVER 只适用于代码明确支持的登录挑战，不能替代设备、短信或其它账号验证。Google/Cloud 页面会变化，动作结果以明确页面证据为准，不因 URL、按钮点击或任务结束就推定成功。
6. **文档与工作区可能不同步**：后续本地修改可能晚于本文档；修改前看 `git diff`、`git status`、对应测试及 [README.md](README.md)。不要仅凭旧截图或以前的运行日志推断当前版本行为。

## 给接手者的最短检查顺序

1. 先读本文、[README.md](README.md)、[动作注册表](src/automation/actions/index.js)、[引擎](src/automation/engine.js)，再读要修改的具体动作/测试。
2. 运行 `git status --short`，保留既有未提交修改；不要把 `data/`、`_tmp_*`、日志、截图或密钥加入提交。若要备份或迁移数据，先停服务并确认存储范围。
3. 运行 `npm test`，在隔离测试数据目录里增加回归测试；针对浏览器/AdsPower 的外部副作用，使用可控 mock 验证目标 ID、失败与取消路径，再考虑任何经用户明确同意的单账号现场测试。
4. 改动动作结果时检查三层一致性：任务 `results`、账号持久状态、前端文案/筛选。把“未确认”“需人工”“明确失败”“明确成功”分开；不要用点击动作或页面加载替代结果证据。
5. 完成后重新核对本文件的“已实现/未实现”边界，并在最终回复中明确哪些通过自动测试、哪些只经静态检查、哪些经真实客户端验证。
