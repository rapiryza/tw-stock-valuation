# 資料檔由 GitHub Actions 產生

例外：`research/` 不是排程產生的，排程也不會改寫或刪除它，見下節。

## research/ — 隊友個股調查（手動匯入）

來源是兩位隊友提供的 JSON（不在 repo 內），用 `python3 scripts/import_research.py --captain <captain.json> --ryza <ryza.json>` 重新匯入。
腳本會先清空 `captain/`、`ryza/` 裡舊的單檔再重寫。匯入時會去掉第三方法說彙整站的站名與連結（「站名 法說彙整」改為「法說彙整」，連結與只指向該站的來源整筆刪除，規則見腳本 `strip_bg`）；其餘文字原樣保留（含「（推論）」「（自行計算）」與 p14 之類的頁碼）。
`python3 scripts/import_research.py --reclean` 不讀來源檔，只對 repo 內現有檔案重跑同一套清理。

| 檔案 | 內容 |
| --- | --- |
| `research/meta.json` | `captain`：船長原檔除 `stocks` 外的欄位（`generatedAt`、`source`、`count`、`fields`），另加 `codes`（有資料的代號）與 `nodata`（無資料的代號）。`ryza`：Ryza 原檔除 `companies` 外的欄位（`source_agent`、`generated_at`、`description`、`page`、`data_dates`、`sources`、`fields`、`notes`、`count`），另加 `codes`。 |
| `research/captain/<代號>.json` | 船長 · 法說助理的單檔，與原檔 `stocks[代號]` 相同（僅經上述清理）：`code, name, industry, template`（`original`／`biotech`／`nodata`）`, nodata, dataDate, deck, 產業及產品, 新領域, 新領域摘要, 客戶及供應產品[{sector,names,supply}], 客戶備註, 業績展望, 業績展望摘要, 重大事件[{date,type,description,source}], pipeline, preclinical, licenses, otherProducts, sources[{type,url|filename|note}]`。 |
| `research/ryza/<代號>.json` | Ryza 近一年新登錄興櫃調查的單檔，與原檔 `companies[]` 的一筆相同（僅經上述清理）：`code, name, regDate, score`（滿分 10，暫定）`, review, ps_ratio, deck, tags, expansion, outlook, customers[{sector,names,supply}], customerNote, majorEvents[{date,type,text,source}]`；生技公司另有 `kind: "biotech", pipeline, preclinical, licenses, otherProducts`。 |

個股面板開啟後才載入：先讀一次 `meta.json`，代號在 `codes` 裡才抓對應單檔，在「最新法說會簡報」連結正下方分別顯示「法說會重點」與「興櫃新登錄調查」兩節；沒有資料就不顯示該節。面板不顯示資料來源、彙整時間、`deck`（簡報說明）與 `sources`，重大事件的 `source` 空白時不顯示。
