/* Local keyword planning: no model call, no invented translation of place names. */
function buildStockPlan(topic, candidate, shots) {
  const places = {"三清山":"Mount Sanqing", "南北湖":"Nanbei Lake", "西湖":"West Lake Hangzhou", "乌镇":"Wuzhen", "硖石":"Xiashi"};
  const subjects = [[/瀑布/, "waterfall"], [/云|雾/, "mountain mist"], [/湖|水面|水纹/, "lake"], [/树|林|叶/, "forest"], [/古镇|老街|古城/, "ancient town"], [/灯|夜/, "night lights"], [/日落|夕阳|暮色/, "sunset"], [/山|岩/, "mountain"]];
  const place = Object.keys(places).find(name => topic.includes(name));
  const location = place || topic.split(/[，,。；;：:]/)[0].trim().slice(0, 36);
  const items = shots?.length ? shots : [{id:"proposal", title:candidate?.title || "选定方案", visual_prompt:[candidate?.concept, candidate?.signature_motif].filter(Boolean).join(" ")}];
  const rows = [];
  const add = (query, id, kind) => {
    if (!query) return;
    let row = rows.find(row => row.query === query);
    if (!row && rows.length < 12) { row = {query, shot_ids:[], kind}; rows.push(row); }
    if (row && !row.shot_ids.includes(id)) row.shot_ids.push(id);
  };
  items.forEach((shot, index) => {
    const id = String(shot.id || `shot-${String(index + 1).padStart(2, "0")}`);
    add(location, id, "地点候选，需核验");
    if (place) add(places[place], id, "地点候选，需核验");
    const visual = String(shot.visual_prompt || shot.title || "").replace(topic, "");
    const subject = subjects.find(([pattern]) => pattern.test(visual));
    if (subject) add(subject[1], id, "通用补充画面，不代表景点实拍");
  });
  return rows;
}
if (typeof module !== "undefined") module.exports = {buildStockPlan};
