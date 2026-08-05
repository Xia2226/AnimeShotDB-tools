# AnimeShotDB —— 动漫截图题库（更新 + 精简题库构建）

本工具包用于维护 `fancaps_anime_images.jsonl` 题库，并最终**构建出可供网页使用的精简题库** **`anime-library.json`** **与封面图片目录** **`covers/`**，供 [Anime-Frame-Quiz](https://github.com/Xia2226/Anime-Frame-Quiz-Cloudflare) 之类的项目直接部署使用。

> 浏览器/页面只会读取构建产物 `anime-library.json`（约 1.9 MB，gzip 后约 630 KB）和 `covers/` 下的封面小图，不会接触约 1 GB 的原始数据。

## 整体流程总览

本工具链的最终目标，是从 `resources/` 里的原始数据源出发，经过三步处理，最终得到可直接部署的产物：

1. **准备数据源**：`resources/` 下需备好 `subject.jsonlines`（Bangumi dump）、`anime-titles.xml`（AniDB 标题库）、`anime_map.json`（Bangumi↔AniDB 映射）、`fancaps_anime_images.jsonl`（当前完整题库）。
2. **更新**（`start-update.cmd`）：用 Bangumi/AniDB 数据在 FanCaps 上抓取增量截图，产出最新题库，写回 `resources/fancaps_anime_images.jsonl`。
3. **补抓**（`start-retry.cmd`）：对更新后仍未匹配到图片的条目重新搜索，尽量补全题库。
4. **构建**（`start-build-library.cmd`）：把最新题库与 `subject.jsonlines` 清洗、合并、过滤成人内容，并下载封面，生成最终产物：
   - `public/data/anime-library.json`：精简题库，页面直接加载；
   - `public/data/covers/`：Bangumi 封面小图目录；
   - `resources/generated/anime-library-quarantine.json`：被过滤/清理条目的隔离报告，仅存档复核，不发布。

即：**数据源 → 更新 → 补抓 → 构建 → 精简题库 + 封面**。其中构建一步是本工具链的最终目标。

***

## 一、环境准备

电脑需要安装 **Node.js 20.11 或更高版本**（构建脚本使用了 `import.meta.dirname`）。确认方法：

```bat
node --version
```

首次运行 `start-update.cmd` 会自动安装 `cheerio`，首次运行 `start-build-library.cmd` 会自动安装 `undici`（封面下载走本地代理时需要）。也可手动执行 `npm install`。

### 需要放入 resources/ 的数据文件

请把下面 4 个数据文件放到本工具目录的 `resources/` 文件夹中（与 `start-update.cmd` 同级）：

| 文件                           | 来源与说明                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject.jsonlines`          | [bangumi/Archive](https://github.com/bangumi/Archive/releases/tag/archive) 最新 dump（每周三凌晨更新）。解压 `dump-xxxx.zip` 后取出。最新直链可查 <https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json> 。**构建精简题库必需。** |
| `anime-titles.xml`           | 下载：<https://anidb.net/api/anime-titles.xml.gz> （AniDB 标题库，支持未压缩的 `anime-titles.xml` 或 gzip 压缩版 `anime-titles.xml.gz`，脚本会自动识别并解压）。更新器按 `update-config.json` 的 `anidb_titles` 读取；补抓脚本默认查找 `resources/anime-titles.xml`，若不存在会自动尝试同名的 `.gz` 文件。仅更新/补抓时使用。                                   |
| `anime_map.json`             | [Rhilip/BangumiExtLinker](https://github.com/Rhilip/BangumiExtLinker) 整理的 Bangumi 站外链接，取每条动画的 `bgm_id` 与 `anidb_id`。更新器优先用它映射新番；未命中时才用 `anime-titles.xml` 按标题和日期严格补充匹配。                                             |
| `fancaps_anime_images.jsonl` | 当前正在使用的完整题库。每次更新成功后，下一次应使用上一次产出的 `fancaps_anime_images.updated.jsonl` 作为本文件。**构建精简题库必需。**                                                                                                                           |

工具自带文件（勿删）：`start-update.cmd`、`start-retry.cmd`、`start-build-library.cmd`、`update-config.json`、`package.json`、`package-lock.json` 及 `tools/` 下全部脚本。

***

## 二、本机网络与代理

- **FanCaps 访问**：更新/补抓时使用 Windows 自带的 `curl.exe`，自动跟随系统网络设置；浏览器能打开 <https://fancaps.net/> 即可直接运行。配置文件里没有也不需要填写本地代理端口，请保持 `"fancaps_http_transport": "curl"` 不变。
- **Bangumi 封面访问**：构建题库时需要调用 `api.bgm.tv` 下载封面。脚本默认经 `http://127.0.0.1:10808` 代理访问；若你的代理端口不同，先运行 `set HTTPS_PROXY=http://127.0.0.1:<端口>`（或 `HTTP_PROXY`）再启动构建。若全部封面下载失败，多为代理问题，可临时跳过封面（见下文“跳过封面下载”）。

***

## 三、第一步：更新 FanCaps 题库（start-update.cmd）

双击 `start-update.cmd`，脚本自动：

1. 检查所有输入文件；
2. 记录文件大小、时间和哈希；
3. 在 `output/` 生成 `YYYY-MM-DD` 文件夹；同日再次成功运行会生成 `YYYY-MM-DD-02`；
4. 备份输入题库；
5. 用 Bangumi dump 和 AniDB 标题库预检；
6. 测试 FanCaps 连通性；
7. 抓取全部可匹配增量；
8. 校验 JSONL、重复 ID 和原记录完整性；
9. 生成纯增量、合并题库、摘要和日志。

如果中途失败，再次双击会自动进入当天带 `.update-incomplete` 标记的目录，并从 `.partial` 断点继续。

### 产出目录内容（output/YYYY-MM-DD/）

- `fancaps_anime_images.updated.jsonl`：**完整合并题库**，用于替换 `resources/fancaps_anime_images.jsonl`
- `fancaps_anime_images.incremental-only.jsonl`：仅本次新增记录，便于审查
- `unmapped.jsonl`：无法可靠匹配 AniDB 的 Bangumi 候选
- `errors.jsonl`：抓取错误记录
- `update-summary.json`：机器可读的摘要、统计与 SHA-256
- `update.log`：完整运行日志
- `update-config.used.json`：本次实际使用的配置快照
- `backup/fancaps_anime_images.before-update.jsonl`：更新前题库备份
- `SUCCESS.txt`：存在时表示流程全部完成

备份说明：每次只备份真正不可再生的文件——输入题库 `resources/fancaps_anime_images.jsonl`。`subject.jsonlines` 和 `anime-titles.xml` 属于可重新下载的外部数据（且体积巨大），`anime_map.json` 在更新过程中不变，均不逐次备份。

### 重要配置（update-config.json）

- `base_cutoff`：本题库的基准日期，当前保持 `2026-05-27`，可让未映射的旧候选以后继续被发现；
- `to_date`：留空表示运行当天；
- `min_done`：Bangumi 看过人数下限，默认 100；
- `delay_ms`：FanCaps 请求间隔，默认 3000 毫秒；
- `connectivity_test`：是否在正式抓取前先测试 1 条；
- `fancaps_http_transport`：保持 `curl`，避免 Node fetch 的 403。

### 更新完成后的替换

主更新成功后（产出目录存在 `SUCCESS.txt` 且 `update-summary.json` 中 `error_report_records` 为 0），脚本自动用 `output/YYYY-MM-DD/fancaps_anime_images.updated.jsonl` 替换 `resources/fancaps_anime_images.jsonl`。

若 `error_report_records` 不为 0，不会自动替换：请查看 `errors.jsonl` 后手动把 `fancaps_anime_images.updated.jsonl` 复制到 `resources/` 并命名为 `fancaps_anime_images.jsonl`（替换前建议保留原文件，`backup/` 中也有备份）。

***

## 四、第二步：补抓未找到图片的条目（start-retry.cmd）

题库中可能存在未能匹配到图片的条目（`status=not_found` 或 `status=error`）。补抓脚本会先用记录的 `anidb_id` 数字搜索；未找到时再用 `anime-titles.xml` 查出标题依次搜索（自动跳过中文标题），可补回部分 FanCaps 实际收录但当初没搜到的条目。标题库支持 `.xml` 或 `.xml.gz`：默认查找 `resources/anime-titles.xml`，若不存在会自动尝试 `anime-titles.xml.gz` 并自动解压。

**一键方式**：双击 `start-retry.cmd`，按菜单选择：

| 选项    | 操作                                |
| ----- | --------------------------------- |
| 1     | 只查看待补抓列表（不访问网络，不修改数据）             |
| 2 / 3 | 补抓前 50 / 100 条                    |
| 4 / 5 | 补抓后 50 / 100 条                    |
| 6     | 补抓全部（数量较大，建议分批）                   |
| 7     | 按 AniDB ID 补抓（可输入多个，逗号分隔）         |
| 8     | 继续上次中断（断点续跑）                      |
| 9     | 补抓全部 `error` 状态条目（上次请求失败的，建议优先重试） |
| 10    | 按 AniDB ID + 自定义番剧页链接补抓（人工复核歧义条目用）    |

**命令行方式**：`node tools/retry-fancaps-missing.mjs --limit 50`

- 成功补抓的条目会更新图片信息并写回 `resources/fancaps_anime_images.jsonl`（替换前自动备份）；
- 仍未找到的条目保持原内容不变；
- 断点续跑：每处理一条都写断点快照，中断后选 8（或加 `--resume`）从上次位置继续；
- 产出在 `output/YYYY-MM-DD-retry/`：`fancaps_anime_images.retried.jsonl`（本次成功条目）、`fancaps_anime_images.retry.partial.jsonl`（断点快照）、`retry-summary.json`、`retry.log`、`backup/fancaps_anime_images.before-retry.jsonl`。

常用选项：`--dry-run`、`--limit N`、`--limit-tail N`、`--status error`、`--resume`、`--accept-first-ambiguous`、`--override <id>=<番剧页链接>`、`--show-url <链接>`、`--no-replace`、`--out-dir <目录>`。另有只读连接测试脚本：`node tools/test-fancaps-search.mjs --count 3`。

### 人工复核歧义条目

补抓时若查询返回多个候选且标题无法唯一确认，该条目保持 `error` 状态，日志会打印搜索页链接，提示形如：`查询 "ssr" 返回 10 个候选，无法唯一确认…`。复核步骤：

1. 打开日志给出的搜索页（形如 `https://fancaps.net/search.php?q=<查询词>&animeCB=Anime&submit=Submit`），核对番名、年份及条目详情页中的 AniDB ID；
2. 点进正确条目后，复制地址栏的番剧 show 页面链接（形如 `https://fancaps.net/anime/showimages.php?<anidb_id>-<标题>`）——注意是番剧页，**不是单集页或单张图片页**；
3. 用 `--override` 把 AniDB ID 与链接绑定，脚本会跳过搜索、直接抓取该页面全部图片：
   - 首选：双击 `start-retry.cmd` 选 **10**，按提示输入 ID 与链接；
   - 命令行：`node "tools\retry-fancaps-missing.mjs" --anidb-ids <anidb_id> --override <anidb_id>=<链接>`
   - 便捷写法（只支持单个 ID）：`node "tools\retry-fancaps-missing.mjs" --anidb-ids <anidb_id> --show-url <链接>`
   - 多个歧义条目可一次性加多个 `--override`（每条一个）；也可以只写 `--override` 而省略 `--anidb-ids`（脚本自动按 override 里的 ID 定位条目）。
4. 若正确条目恰好是第一个候选，也可直接 `--accept-first-ambiguous` 单条补抓：
   `node "tools\retry-fancaps-missing.mjs" --anidb-ids <anidb_id> --accept-first-ambiguous`

***

## 五、第三步：构建精简题库与封面（start-build-library.cmd）★

前置条件：`resources/fancaps_anime_images.jsonl` 已是最新（最好完成第一、二步），且 `resources/subject.jsonlines` 存在。

双击 `start-build-library.cmd`，脚本自动检查 Node 版本与输入文件，然后按菜单选择：

| 选项 | 操作                                               |
| -- | ------------------------------------------------ |
| 1  | 完整构建：生成精简题库并下载全部封面（推荐，首次使用）                      |
| 2  | 仅构建题库：跳过封面下载（封面字段留空，适合先验证题库）                     |
| 3  | 校验：检查已生成的题库与隔离报告（不访问网络）                          |
| 4  | 强制刷新封面并完整构建：忽略本地已有封面，全部重新下载（如 Bangumi 更换了封面图时使用） |

### 构建做了什么

1. 流式读取 `fancaps_anime_images.jsonl`，只保留 `status=ok` 且至少含一张合法 FanCaps JPG 图片 ID 的记录；
2. 清理冲突与重复：隔离 `show_url` 被多个 AniDB ID 共同引用的整组冲突行、同一 AniDB ID 对应多行的组、跨番剧共享的图片 ID，并删除因此无图的记录；
3. 流式扫描 `subject.jsonlines`，只解析题库所需的 Bangumi 条目，要求唯一匹配且 `type = 2`；
4. 拼接标题、原名、日期、评分、排名、看过/评分人数、标签等基础信息；
5. 剔除 `nsfw` 或带里番、色情、R18、工口、H、肉番、擦边等高置信成人标签的条目；仅有“卖肉/肉/福利/杀必死”时保留，过滤依据全部写入隔离报告；
6. 从 Bangumi 下载每部番剧的封面小图到 `public/data/covers/`（并发 12，失败自动重试；个别失败回退为远程 URL，全部失败或跳过时留空）；
7. 原子写入最终产物，并输出统计报告。

### 产物说明

| 产物   | 路径                                                  | 说明                                                                                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 精简题库 | `public/data/anime-library.json`                    | 页面直接加载的数据，含 `version`、`imageBase`、`stats`、`tags`、`anime` 字段；每条 anime 含 `bgmId`、`anidbId`、`title`、`originalTitle`、`date`、`score`、`rank`、`nsfw`、`doneCount`、`ratingCount`、`tags`、`metaTags`、`imageIds`、`cover`。截图地址 = `imageBase` + `imageIds` 中的数字 + `.jpg`；`cover` 为本地路径 `/data/covers/<bgmId>.jpg`（或远程 URL，失败时可能为空） |
| 封面目录 | `public/data/covers/`                               | 每部番剧一张 `<bgmId>.jpg` 封面小图                                                                                                                                                                                                                                                                                            |
| 隔离报告 | `resources/generated/anime-library-quarantine.json` | 被清理/过滤的详情（冲突、重复、共享图、成人内容）与构建统计，仅存档复核，不作为部署资源                                                                                                                                                                                                                                                                         |

本次（2026-08-05 数据）构建结果：原始 6604 行 → 合格 2632 条 → 合并清理后 1981 部 → 剔除成人内容 82 部 → **最终 1899 部番剧、117,593 张截图、3,316 个标签**；`anime-library.json` 约 1.93 MB，gzip 后约 634 KB。

### 命令行方式与参数

```bat
npm run build:data        :: 等同 node tools/build-anime-library.mjs
npm run check:data        :: 等同 node tools/build-anime-library.mjs --check
```

构建脚本支持自定义路径：`--fancaps <路径>`、`--subjects <路径>`、`--output <路径>`、`--quarantine <路径>`；`--check` 仅校验不构建，`--force-covers` 忽略本地已有封面、全部重新下载（等价于菜单 4）。

环境变量：

- `NO_COVER_FETCH=1`：跳过封面下载（等价于菜单 2），可用于网络不可用时先构建题库；
- `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`：封面下载代理，默认 `http://127.0.0.1:10808`。

***

## 六、部署到网页项目（Anime-Frame-Quiz）

构建完成后，把两个产物部署到目标项目的 `public/data/` 下（路径需与题库中的 `cover` 字段 `/data/covers/...` 对应）：

```text
public/data/anime-library.json     ← 复制自本工具的 public/data/
public/data/covers/                ← 复制自本工具的 public/data/covers/
```

`resources/generated/anime-library-quarantine.json` 仅作档案，不要发布。替换题库后重新打开页面即可使用新数据；若需复查构建结果，可再次运行 `start-build-library.cmd` 选 3（校验模式）。

***

## 七、目录结构

```text
├── start-update.cmd               # ① 增量更新题库（一键）
├── start-retry.cmd                # ② 补抓未找到图片的条目（一键菜单）
├── start-build-library.cmd        # ③ 构建精简题库与封面（一键菜单）★
├── update-config.json             # 更新配置
├── package.json / package-lock.json
├── resources/                     # 本地原始数据（不作为线上资源）
│   ├── fancaps_anime_images.jsonl # 当前完整题库（输入）
│   ├── subject.jsonlines          # Bangumi dump（输入，构建必需）
│   ├── anime-titles.xml
│   ├── anime_map.json
│   └── generated/anime-library-quarantine.json   # 构建隔离报告（输出）
├── tools/
│   ├── update-fancaps.mjs         # ① 更新主逻辑（编排器）
│   ├── append-fancaps-new-anime.mjs  # 更新：增量抓取
│   ├── finalize-update.mjs        # 更新：校验与摘要
│   ├── retry-fancaps-missing.mjs  # 补抓脚本
│   ├── build-anime-library.mjs    # 构建精简题库脚本 ★
│   └── test-fancaps-search.mjs
├── output/                        # 更新/补抓产出（按日期分目录）
└── public/                        # 构建产物（部署用）
    └── data/
        ├── anime-library.json     # ★ 精简题库
        └── covers/                # ★ 封面图片目录
```

***

## 八、常见问题

- **构建时报“清洗后仅有 N 部番剧”**：`subject.jsonlines` 与题库无法 100% 连接或数据过少（脚本要求至少 50 部）。请确认两个输入文件都是最新且同期的。
- **封面全部下载失败**：多为代理问题。检查代理端口（默认 `http://127.0.0.1:10808`），或先 `set HTTPS_PROXY=http://127.0.0.1:<端口>`；紧急时可 `set NO_COVER_FETCH=1` 跳过封面。
- **重复构建会不会重复下载封面**：不会。`covers/` 是固定目录，已存在的 `<bgmId>.jpg` 会直接复用（不联网），每次构建只补齐新番剧的封面并清理已删除番剧的旧封面。
- **想强制刷新封面（如 Bangumi 更换了封面图）**：运行 `start-build-library.cmd` 选菜单 4，或命令行加 `--force-covers`，会忽略本地已有封面、全部重新下载（未下载成功的仍会回退为远程 URL 或留空）。
- **更新/补抓失败**：查看 `output/` 当日目录下的 `update.log` / `retry.log`；断点续跑可从中断处继续。
- **题库替换后页面未生效**：确认 `anime-library.json` 与 `covers/` 已复制到目标项目 `public/data/`，并清空浏览器缓存。

