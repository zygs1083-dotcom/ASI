# ASI 外观规范（参考 magpie）

参考对象：magpie 桌面应用（MacPro 已安装 `/Applications/magpie.app`，可打开对照）。以下数值从 magpie 界面实测提取。
目标：看起来像 magpie 的"同门兄弟"——安静的灰底、白色卡片列表、紧凑 13px 正文、靛蓝强调色，原生 macOS 质感。

## 1. 设计令牌（逐字放进 `src/renderer/styles/tokens.css`）

```css
:root {
  --bg:#f4f4f6; --card:#ffffff; --card-2:#f9f9fb;
  --pill:#f1f1f4; --pill-hover:#e9e9ee;
  --seg-track:#e6e6eb; --seg-thumb:var(--card);
  --seg-edge:0 1px 2px rgba(0,0,0,.14),0 0 0 .5px rgba(0,0,0,.08);
  --ctl-fg:#63636b; --line:#e3e3e8; --line-2:#ececf0;
  --fg:#1c1c21; --fg-2:#4b4b53; --muted:#85858d; --faint:#b9b9c2;
  --accent:#4f46e5; --accent-soft:#eeedfd; --accent-fg:#ffffff; --sel:#ecebfb;
  --green:#189a58; --green-soft:#e4f6ec; --red:#d64545; --red-soft:#fbe9e9;
  --amber:#b45309; --amber-soft:#fbf0df;
  --pop-bg:rgba(255,255,255,.94);
  --shadow:0 16px 44px rgba(20,22,30,.16),0 2px 8px rgba(20,22,30,.06),0 0 0 .5px rgba(20,22,30,.1);
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",system-ui,sans-serif;
  --code:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#1a1a1e; --card:#232327; --card-2:#1f1f23; --pill:#2d2d33; --pill-hover:#36363d;
  --seg-track:rgba(255,255,255,.035); --seg-thumb:rgba(255,255,255,.15);
  --seg-edge:inset 0 .5px 0 rgba(255,255,255,.08),0 1px 2px rgba(0,0,0,.3);
  --line:#333339; --line-2:#2c2c32; --fg:#ededf1; --fg-2:#b9b9c1; --muted:#8b8b94; --faint:#56565f;
  --ctl-fg:#a1a1aa; --accent:#a5b4fc; --accent-soft:#2b2c47; --accent-fg:#14142a; --sel:#33345a;
  --green:#6fd99b; --green-soft:#1e3a2b; --red:#f28b82; --red-soft:#45272a; --amber:#f2b544; --amber-soft:#3f3220;
  --pop-bg:rgba(38,38,43,.96);
  --shadow:0 16px 44px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.3),0 0 0 .5px rgba(255,255,255,.1);
}}
:root[data-theme="dark"] { /* 与上面 dark 块相同的值 */ }
```

## 2. 排版与尺寸

| 元素 | 规格 |
|---|---|
| 正文 | 13px / `--fg`；次要文字 12px `--muted` |
| 侧栏 | 宽 212px，背景 `--bg`（与主区同色），右侧 1px `--line` 分隔 |
| 侧栏分组标题 | 11px、500、`--muted`，padding `14px 8px 4px` |
| 侧栏项 | 高 30px、圆角 7px、padding `0 8px`、图标 16px + 文字；默认 `--fg-2` 400；选中：白色 `--card` 背景 + `--seg-edge` 阴影 + `--fg` 500 |
| 顶栏 | 高 44px，面包屑：上级 `--muted` + " / " + 当前页 15px 600 `--fg`；macOS 红绿灯区域留出（`titleBarStyle: 'hiddenInset'`，侧栏顶部留 28px 拖拽区，`-webkit-app-region: drag`） |
| 列表卡片 | 白底 `--card`、1px `--line`、圆角 12px；行之间 1px `--line-2` 分隔；行高约 50px，padding `0 14px`；行内：图标 28px + 两行文字（标题 13px `--fg`，副标题 12px `--muted`）+ 右侧状态/开关/`›` |
| 输入框 | 高 26–30px、1px `--line`、圆角 7px、12–13px；focus 边框 `--accent` + 3px `--accent-soft` 光圈 |
| 药丸按钮 | 背景 `--pill`、hover `--pill-hover`、圆角 7px、高 26px、12px `--ctl-fg` |
| 主按钮 | `--accent` 底 `--accent-fg` 字，圆角 7px |
| 开关 | 36×20，开 = `--fg` 底 + `--card` 圆点（浅色主题即深底白点，与 magpie 一致；深色主题自然反相为浅底深点，可接受），不用强调色；关 = `--seg-track` |
| 状态点 | 6px 圆点：`--green` 已配置 / `--faint` 未配置 / `--red` 出错 |
| 弹出层 | `--pop-bg` + `backdrop-filter: blur(20px)` + `--shadow`，圆角 10px |

图标：线性 16px（stroke 1.5），推荐 `lucide-react`。动效：只做 120–160ms 的颜色/透明度过渡，无弹跳。

## 3. 页面

### 侧栏（固定）
- 顶部：Logo "ASI"（15px 700）+ 折叠按钮（可选）。
- 分组「对话」：`+ 新对话` 项，下面是会话列表（按更新时间倒序，标题单行省略，hover 出现删除 `×`，双击重命名）。
- 底部固定：`设置` 项（齿轮）；再下一行 12px `--muted`：绿/灰点 + 当前默认模型名（未配置显示"未配置模型"）。

### 对话页（面包屑：对话 / <会话标题>）
- 消息区：居中，最大宽 760px，上下留白 24px。
  - 用户消息：右对齐气泡，`--pill` 背景、圆角 12px、padding `8px 12px`、最大宽 80%。
  - 助手消息：左对齐无气泡，正文 14px 行高 1.65，支持 Markdown（代码块 `--card-2` 底、`--code` 字体、圆角 8px、右上"复制"）。
  - 流式中末尾显示闪烁光标；错误：`--red-soft` 底小条 + 错误文字 +「重试」；中止：灰色小字"已停止"。
  - 空会话：居中显示 "开始对话" + 当前模型药丸；未配置任何厂商时显示"先去配置模型厂商"按钮跳转设置。
- 输入区（底部固定）：白色卡片（`--card`、1px `--line`、圆角 12px、`--seg-edge`）。多行 textarea 自动增高（最多 8 行），Enter 发送、Shift+Enter 换行；左下：**模型药丸**（显示 "厂商 · 模型"，点开弹出按厂商分组的可搜索列表）；右下：发送按钮（圆形 28px `--accent`，箭头）↔ 流式中变成停止按钮（方块）。

### 设置页（面包屑：设置 / 模型厂商）
- 顶部右侧：搜索框「查找厂商」+ 药丸按钮「+ 添加厂商」。
- 厂商列表卡片（仿 magpie Providers 页）：每行 = 首字母圆形图标（`--accent-soft` 底 `--accent` 字）+ 名称 + 副标题（`baseUrl 或 pi-ai 厂商名 · N 个模型`）+ 状态（绿点"已设置 Key"/灰点"未设置 Key"）+ 启用开关 + `›`。
- 点行或添加 → 右侧滑出/主区切换的**编辑面板**：
  - 类型：分段控件「内置厂商 | OpenAI 兼容」。
  - 内置：下拉选 pi-ai 厂商（显示模型数）；可选"自定义 Base URL"。
  - OpenAI 兼容：名称、Base URL（必填，示例 `http://localhost:11434/v1`）、模型 id 列表（输入回车添加为标签）。
  - API Key：密码框，已保存时显示 `••••••••（已保存）` 和「清除」；永不回显明文。
  - 模型列表预览 + 每个模型旁「测试」按钮（显示 ✓ 延迟 ms 或 ✗ 错误）。
  - 底部：「删除厂商」（红字）· 「取消」· 「保存」。
- 设置页下方第二个卡片「通用」：默认模型（同模型药丸选择器）、外观（分段控件 跟随系统/浅色/深色）。

## 4. 验收截图

e2e 在 1100×720 窗口下产出：`artifacts/screens/{chat-empty,chat-streaming,chat-done,providers-list,provider-edit}-{light,dark}.png`。评审对照 magpie 实物检查：灰底+白卡片层级、13px 紧凑感、选中项白底阴影、开关开启态用 `--fg`、强调色只用于主操作。
