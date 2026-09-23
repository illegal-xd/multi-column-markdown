# dataview test

```dataviewjs
const folder = "preview/"
const pages = dv.pages(`"${folder}"`)
    .sort(p => p.file.name, 'desc');

// 构建表格数据
const rows = pages.map(p => [
  p.file.name.replace(/\.md$/, ''),           // 版本名
  `[[${p.file.path}|${p.file.name}]]`,        // 内部链接（显示为文件名）
  p.date || '—',                              // 日期（若没有则显示 —）
  p.note || '—',                              // 备注（若没有则显示 —）
  p.created || '-'
]);

dv.table(
  ["版本", "链接", "日期", "备注", "创建时间"],
  rows
);
```