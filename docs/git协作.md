# KeyGo Git 协作实战手册

> 目标：不只是记住几条命令，而是真正理解 Git 的工作方式，能独立应对日常开发、协作、冲突、回退等绝大多数场景。
> 本文以 KeyGo 项目（远程 `https://github.com/wild-civil/Keygo.git`）的真实分支（`main` / `codebuddy` / `codex` / `workbuddy` / `master`）为例，所有命令可直接套用。

---

## 0. 为什么需要规范流程

Git 本身很灵活，但**灵活=容易乱**。团队协作时如果没有约定，会出现：

- 直接在 `main` 上改，别人一拉就把你的半成品拉走了；
- 两个人改同一个文件，push 互相覆盖；
- 提交了一堆 "fix"、"改了一下"，半年后没人看得懂；
- 误把密钥 / 大文件 / 构建产物提交进去，想删都删不干净。

本手册的核心理念只有一句话：**`main` 永远是可发布的状态；所有开发都在独立分支上做；合并前走 PR（Pull Request）。**

---

## 1. 先理解四个核心概念（看懂这段，后面全通）

### 1.1 三个工作区域

```
工作区(Working Directory)  ──git add──▶  暂存区(Staging Area)  ──git commit──▶  本地仓库(Local Repo)
  你编辑器里看到的文件               准备进本次提交的文件               永久保存的提交历史
```

- **工作区**：你正在改的文件。
- **暂存区（索引）**：`git add` 之后，文件快照被放这里，作为「下一次 commit 的内容」。
- **本地仓库**：`.git` 目录，所有 `commit` 永久存这里。
- **远程仓库（Remote，如 `origin`）**：GitHub 上的那份，用来和别人同步。

### 1.2 提交（commit）= 一个快照 + 一个身份证

每次 `commit` 会生成一个 40 位 SHA-1 哈希（如你刚才的 `ada7d72...`），它是这次快照的唯一 ID。Git 里所有"回退/对比/恢复"最终都靠这些哈希。

### 1.3 分支（branch）= 一个会移动的指针

分支本质只是指向某个 commit 的**指针**。你在分支上提交，指针就往前移。

- `main` 指向主线的最后一个提交；
- 你 `git switch -c codebuddy` 时，新建一个 `codebuddy` 指针，指向当前同一个提交，之后各自往前走，互不影响。

> 关键认知：**分支很轻量，随便建、随便删，不要舍不得开分支。**

### 1.4 HEAD = "我现在在哪"

`HEAD` 是个特殊指针，永远指向你**当前所在的分支/提交**。

- 正常：`HEAD -> codebuddy -> ada7d72`
- 切到某个旧 commit 但不建分支时：`HEAD -> ada7d72`（这就是" detached HEAD / 游离头"，见第 15 节）。

---

## 2. 安装与一次性全局配置

```bash
# 安装（Windows 推荐 Git for Windows，自带 Git Bash）
# 装好后第一件事：告诉 Git 你是谁（每次 commit 都会记录）
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱@xxx.com"

# 让新建分支默认叫 main（而不是老旧的 master）
git config --global init.defaultBranch main

# 拉取时默认用 rebase（保持历史线性，详见第 6 节）
git config --global pull.rebase true

# 中文文件名/路径正常显示（避免你仓库里那种 128... 乱码感）
git config --global core.quotepath false

# 顺手设几个好用的别名（可选，但强烈推荐）
git config --global alias.st  "status -sb"
git config --global alias.co  "switch"
git config --global alias.br  "branch -vv"
git config --global alias.lg  "log --oneline --graph --all --decorate -20"
git config --global alias.unstage "restore --staged"
```

配置后可用 `git config --global -l` 查看。

---

## 3. 第一次拿到项目

### 场景 A：从零开始（克隆远程仓库）

```bash
git clone https://github.com/wild-civil/Keygo.git
cd Keygo
git branch -a          # 看本地+远程所有分支
git switch codebuddy   # 切到你要开发的分支（自动跟踪 origin/codebuddy）
```

### 场景 B：你已经有本地仓库（就是现在的情况）

你本地已经在 `codebuddy` 分支，工作区是干净的（只有那个未跟踪的说明文件 `128。仍需用户重做...`，不影响）。此时**不需要 clone**，直接往后做即可。

确认一下状态：

```bash
git status -sb         # 看当前分支 + 是否有未提交改动
git log --oneline -5   # 看最近 5 条提交
```

---

## 4. 单人日常开发闭环（你 90% 的时间在做这件事）

以"在 `codebuddy` 上加一个新功能"为例：

```bash
# ① 确保自己在正确的分支，且基于最新的 main
git switch codebuddy
git fetch origin                 # 把远程最新状态拉到本地（不合并）
git rebase origin/main           # 把你的提交叠到最新 main 之上（保持线性）

# ② 改代码……（用编辑器随便改）

# ③ 看改了什么
git status                       # 哪些文件变了（红=未暂存，绿=已暂存）
git diff                         # 工作区 vs 暂存区 的具体改动

# ④ 把改动放进暂存区
git add app/BLE_Key_Go_App/stores/ble.js   # 只加某个文件（推荐，精确）
# 或者：git add -p                            # 交互式：只暂存文件里的某些段落
# 或者：git add .                             # 加当前目录所有改动（谨慎，容易误加）

# ⑤ 提交（写清楚"为什么"，不是"改了啥"）
git commit -m "fix(Keygo-Foreground): 重写 createBond 为同步阻塞模式

原异步 invokeAndKeepAlive 被 Weex 自动收尾，JS 永远收 null。
改为 CountDownLatch 阻塞等 OS 配对广播，单次 callback.invoke 返回真实结果。"

# ⑥ 推到远程（首次加 -u 建立跟踪）
git push -u origin codebuddy
```

> **提交信息规范**（本项目约定，参考现有历史）：
> - 格式：`类型(范围): 一句话摘要` + 空行 + 详细描述（为什么、根因、修复点）。
> - 类型：`feat`(新功能) / `fix`(修复) / `docs`(文档) / `refactor`(重构) / `chore`(杂务) / `revert`(回退)。
> - 例：`fix(固件): 恢复出厂复位阈值 5s->8s 并改三相 LED 反馈`。

---

## 5. 分支管理大全

```bash
# 看分支
git branch              # 本地分支（* 是当前）
git branch -a           # 含远程分支
git branch -vv          # 含跟踪关系 + 最新提交（最常用）

# 新建并切换（推荐 switch）
git switch -c myfeature            # 基于当前 HEAD 开新分支
git switch -c myfeature origin/main  # 基于远程 main 开新分支（干净起点）

# 切换
git switch main
git switch codebuddy

# 改名
git branch -m oldname newname

# 删除
git branch -d myfeature     # 已合并才允许删
git branch -D myfeature     # 强制删（未合并的提交会丢失！）

# 看某分支和 main 差了什么
git log main..codebuddy --oneline     # codebuddy 有、main 没有的提交
git diff main...codebuddy             # 两边内容差异
```

> **多 agent 分支共存（KeyGo 现状）**：你已经有了 `codebuddy`、`codex`、`workbuddy`、`master` 多条分支，分别给不同 AI agent / 用途并行开发。它们互不干扰，各自 push 自己的分支，最后通过 PR 合回 `main`。**不要在别人的分支上乱提交。**

---

## 6. 与远程同步（新人最晕的地方）

### 6.1 三个动作的区别

| 命令 | 作用 |
|------|------|
| `git fetch origin` | 只把远程最新数据**下载**到本地（不动你的文件），安全 |
| `git merge origin/main` | 把远程 main 合进当前分支 |
| `git pull` | = `fetch` + `merge`（若配了 `pull.rebase=true` 则是 `fetch` + `rebase`） |
| `git push` | 把本地提交**上传**到远程 |

### 6.2 第一次 push 一定要 `-u`

```bash
git push -u origin codebuddy
```

`-u`（`--set-upstream`）做两件事：
1. 远程没有 `codebuddy` 就**自动创建**；
2. 把本地 `codebuddy` 关联到 `origin/codebuddy`。

之后在这个分支上直接 `git push` / `git pull` 即可，不用再带参数。

### 6.3 你当前的真实操作（切回 main 再 push）

```bash
# 切回 main
git switch main
# 如果 main 有跟踪（你有），直接：
git push origin main
# 如果切回 main 后没新提交，会提示 Everything up-to-date

# 再切回你的开发分支
git switch codebuddy
```

### 6.4 推送被拒（non-fast-forward）

如果你 push 时别人已经往同一分支推了东西，会报：

```
! [rejected]        codebuddy -> codebuddy (fetch first)
error: failed to push some refs (non-fast-forward)
```

解决：先同步再推

```bash
git pull --rebase origin codebuddy   # 把别人的提交拉下来，把你的提交叠上去
git push origin codebuddy
```

> **黄金法则**：push 前先 `pull --rebase`；rebase 后若已推过远程，需 `git push --force-with-lease`（见第 15 节，慎用）。

---

## 7. 同步别人的改动（实战）

假设同事在 `main` 上合并了新功能，你要跟上：

```bash
git switch codebuddy
git fetch origin
git rebase origin/main
```

rebase 的过程：`codebuddy` 上你的提交会**暂时撤下** → 先把 `origin/main` 的新提交接上 → 再把你的提交一个一个重放上去。结果是一条干净的直线历史，没有多余的 "Merge branch 'main'" 提交。

> **rebase vs merge 怎么选？**
> - 自己分支同步 main：**用 rebase**（历史干净）。
> - 把功能分支合回 main（PR 里）：**用 merge（GitHub 的 "Squash and merge" 或 "Merge" 按钮）**（保留分支上下文）。
> - 原则：**不要对已经 push 给别人、别人可能基于它开发的分支做 rebase**（会改写历史，坑队友）。

---

## 8. 冲突解决（最实战，必会）

冲突不可怕，它是 Git 在说"这两处我都改了，你来拍板"。

### 8.1 怎么制造/遇到冲突

当你 `rebase` / `merge` / `pull` 时，若同一文件的同一区域两边改得不一样，Git 会停下并标记冲突。

### 8.2 冲突文件长这样

```js
function connect(deviceId) {
<<<<<<< HEAD
  // 你本地的版本
  return openGatt(deviceId)
=======
  // 别人（origin/main）的版本
  return bluetooth.connect(deviceId, { auto: true })
>>>>>>> origin/main
}
```

- `<<<<<<< HEAD` 到 `=======`：你这边的改动
- `=======` 到 `>>>>>>> xxx`：对方/目标的改动

### 8.3 解决步骤

```bash
# 1. 看哪些文件冲突
git status            # 标 "both modified" 的就是

# 2. 用编辑器打开，手动改成正确的最终版本（删掉 <<< === >>> 标记）
#    可以保留一边、合并两边、或重写

# 3. （可选）用图形化工具更直观
git mergetool         # 需要提前配置如 VS Code / Beyond Compare

# 4. 改完一个就标记为已解决
git add app/BLE_Key_Go_App/stores/ble.js

# 5. 全部解决后，继续 rebase / merge
git rebase --continue      # 如果是 rebase 中途冲突
# 或 git commit            # 如果是 merge 冲突
```

### 8.4 不想解决了，要反悔

```bash
git rebase --abort     # 放弃这次 rebase，回到 rebase 前的状态
git merge --abort      # 放弃这次 merge
```

---

## 9. 暂存：stash（切换分支前的救命稻草）

你正改到一半，突然要切到别的分支修紧急 bug，但又不想 commit 半成品：

```bash
git stash                 # 把当前未提交的改动藏起来（工作区变干净）
git switch main           # 干净切换
# ... 切回来 ...
git switch codebuddy
git stash pop             # 把藏起来的改动恢复回来

# 常用变体
git stash list            # 看有哪些 stash
git stash push -m "半成品-配对逻辑"   # 带备注，方便辨认
git stash drop            # 删掉最近的 stash
```

---

## 10. 撤销与"后悔药"

Git 里几乎**没有真正删不掉的东西**（只要 commit 过，基本都能找回来）。

### 10.1 改了但还没 `add`

```bash
git restore app/.../ble.js        # 丢弃这个文件的工作区改动（回到上次 commit）
# 老写法：git checkout -- app/.../ble.js
```

### 10.2 `add` 了但还没 `commit`

```bash
git restore --staged app/.../ble.js   # 把文件从暂存区撤出（改动还在工作区）
# 老写法：git reset HEAD app/.../ble.js
```

### 10.3 `commit` 了，想补点东西 / 改信息

```bash
# 追加改动到上一次提交（不新增 commit）
git add 漏掉的文件
git commit --amend -m "新的提交信息"

# ⚠️ 如果已经 push 过，amend 会改写历史，需用 --force-with-lease 强推（见 15）
```

### 10.4 `commit` 了，但整次都错了

```bash
# 回退到上一个提交，但保留工作区改动（最安全，改动还在，只是"取消提交"）
git reset --soft HEAD~1

# 回退且把改动也清空（危险：工作区改动没了）
git reset --hard HEAD~1

# ✅ 推荐给"已 push 的公共分支"用的安全回退：再提交一次反向修改
git revert <要撤销的commit哈希>
```

> **`reset` vs `revert`**：
> - `reset`：抹掉历史（改写了过去），只用于**自己还没 push 的本地提交**。
> - `revert`：新增一个"反向提交"来抵消，历史不丢，可用于**已 push 的公共分支**。

### 10.5 终极后悔药：`reflog`

就算你 `reset --hard` 删了提交，只要还在本地 `.git` 里，就能靠 reflog 找回来：

```bash
git reflog              # 列出 HEAD 的每一次移动，带哈希
git reset --hard HEAD@{2}   # 回到 reflog 里的第 3 行状态
```

> 这是 Git 最强大的保命功能，删错东西第一时间用 `git reflog`。

---

## 11. 查看历史与排查

```bash
git log --oneline -10               # 最近 10 条，单行
git log --oneline --graph --all -20 # 图形化看全部分支
git lg                              # 上面那条（如果你设了 alias）

git show ada7d72                   # 看某次提交的详细改动
git show HEAD                      # 看最近一次

git diff main codebuddy            # 两个分支内容差异
git diff HEAD~3 HEAD               # 最近 3 次提交的累计差异

git blame app/.../ble.js           # 每一行是谁、哪次提交写的（查锅用）
```

---

## 12. 标签（tag）：给发布版本打点

```bash
git tag v3.34.0                 # 在当前提交打轻量标签
git tag -a v3.34.0 -m "正式发布 3.34.0"   # 带注解的标签（推荐）
git push origin v3.34.0         # 推标签到远程（tag 不会随 push 自动上传）
git tag                         # 看本地标签
git push origin --tags          # 推所有标签
```

---

## 13. 团队协作流程（本项目推荐）

### 13.1 分支模型

```
main          ← 受保护，永远可发布；只通过 PR 合并
 ├── codebuddy   ← 你（主开发）的功能/修复分支
 ├── codex       ← 另一个 AI agent 的分支
 ├── workbuddy   ← 另一个 agent / 用途分支
 └── master      ← 历史分支（保留，不主动动）
```

规则：
1. **绝不在 `main` 上直接开发**。
2. 每个任务开一个分支（名字见名知意：`fix/createbond`、`feat/passkey-ui`）。
3. 开发完 `push` 自己的分支 → 在 GitHub 提 **PR** 合进 `main`。
4. PR 通过 review 后才合并（哪怕是你自己，也走一遍，留记录）。

### 13.2 一次完整 PR 流程（你自己的日常）

```bash
# 1. 在功能分支上开发、提交、推送
git switch -c fix/createbond
# ... 改代码、git add、git commit ...
git push -u origin fix/createbond

# 2. 去 GitHub 仓库页面 → Pull requests → New pull request
#     base: main  ←  compare: fix/createbond
#    填标题+说明 → Create pull request

# 3. 自己或协作者 review，确认无误点 "Squash and merge"
#    （把分支上的多个提交压成一个干净的提交合进 main）

# 4. 合并后，本地清理
git switch main
git pull origin main
git branch -d fix/createbond
```

### 13.3 外部贡献者（Fork 流程）

1. GitHub 页面点 **Fork**，把仓库复制到自己的账号；
2. `git clone https://github.com/自己的账号/Keygo.git`；
3. 开分支 → 改 → `git push -u origin 分支`（推到**自己的 fork**）；
4. 在自己 fork 页面提 PR 到原仓库 `main`。

---

## 14. KeyGo 实战场景对照

### 14.1 你当前的真实状态

```
分支 codebuddy，最新提交 ada7d72（配对修复，已 commit 未 push）
远程 origin = https://github.com/wild-civil/Keygo.git
本地 codebuddy 尚未设置上游（远程可能还没有 codebuddy 分支）
```

### 14.2 把 codebuddy 推到远程

```bash
git push -u origin codebuddy
# 远程没有该分支 → 自动创建，并建立跟踪；之后直接 git push 即可
```

### 14.3 切回 main 并 push

```bash
git switch main
git push origin main        # main 已跟踪 origin/main，直接 push 也行
git switch codebuddy        # 干完切回来继续开发
```

### 14.4 多 agent 分支互不干扰

- 你在 `codebuddy` 改 App 配对逻辑；`codex` 可能在改别的；`workbuddy` 在整理文档。
- 各自 `push -u origin 自己的分支`，互不 overwrite。
- 谁的功能先稳定，谁先提 PR 合 `main`；合并后其他人 `git rebase origin/main` 跟上。

---

## 15. 常见坑与急救

### 15.1 detached HEAD（游离头）
现象：`git status` 显示 `HEAD detached at ada7d72`。
原因：你 `git checkout <某个提交哈希>` 而不是分支名。
解决：
```bash
git switch -c temp-fix     # 基于当前游离点建个分支，就回到正常状态
# 或 git switch codebuddy 直接回到分支
```

### 15.2 non-fast-forward（推送被拒）
见第 6.4 节：`git pull --rebase` 再 push。

### 15.3 强推灾难
**永远不要** `git push --force` 到 `main` 或别人的分支，会抹掉别人的提交。
如果必须强推自己的分支（比如 rebase 后）：
```bash
git push --force-with-lease origin codebuddy
```
`--force-with-lease` 比 `--force` 安全：若远程有你本地不知道的新提交，它会拒绝，防止误覆盖别人。

### 15.4 误提交了大文件 / 密钥 / node_modules
- 还没 push：用 `git reset --soft HEAD~1` 撤提交，删文件，重新 commit；并在 `.gitignore` 里补上。
- 已经 push：不能简单删，历史里还有。用 `git filter-repo`（或老工具 `git filter-branch`）清理，操作前务必备份、并通知协作者重新 clone。

### 15.5 中文文件名 / 路径乱码
你仓库里有个 `128。仍需用户重做...` 的未跟踪文件（是说明文档/截图，不是代码，别 add 它）。已配置 `core.quotepath false` 可正常显示。建议这种说明性文件放到 `docs/` 或 `自己看/` 目录，并保持 ASCII 文件名，避免跨平台乱码。

### 15.6 换行符（Windows CRLF vs Linux LF）
Windows 上建议：
```bash
git config --global core.autocrlf true    # 检出转 CRLF，提交转 LF（纯 Windows 项目）
# 或项目根放 .gitattributes 统一：* text=auto
```

---

## 16. 速查表（贴在显示器旁）

```bash
git status -sb                 # 当前状态（随时用）
git add <文件> / git add -p    # 精确暂存
git commit -m "..."            # 提交
git commit --amend             # 补改上一次提交
git switch -c <分支>           # 新建并切换分支
git switch <分支>              # 切换分支
git branch -vv                 # 看分支与跟踪
git fetch origin               # 下载远程最新（不合并）
git pull --rebase origin <分支> # 拉取并线性重放
git push -u origin <分支>      # 首次推送+建跟踪
git rebase origin/main         # 同步主线
git merge --abort / rebase --abort   # 放弃合并/变基
git stash / git stash pop      # 暂存/恢复
git reset --soft HEAD~1        # 撤提交留改动
git revert <哈希>              # 安全回退已 push 的提交
git reflog                     # 后悔药（找丢失的提交）
git lg                         # 图形化历史
```

---

## 17. 练习路线（真的熟练起来）

1. **第一天**：在 `codebuddy` 上随便改一行注释，`add` → `commit` → `push -u`，感受完整闭环。
2. **第二天**：`git switch -c playground` 开个练习分支，故意制造一次冲突（`rebase origin/main` 时改同一个文件），亲手解一次。
3. **第三天**：`git commit --amend` 改一次提交信息；`git reset --soft HEAD~1` 撤一次提交；`git reflog` 看自己的操作轨迹。
4. **一周后**：给自己某个功能提一个 PR 合进 `main`，体验 review 流程。

> Git 不是背出来的，是**改出来、错出来、救出来**的。大胆在分支上试，搞砸了有 `reflog` 兜底。
