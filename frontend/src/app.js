import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  page: "list",
  rows: [],
  merges: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  merge: {
    selected: new Set(),
    preview: null,
    error: "",
    msg: "",
    busy: false,
  },
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
    // 丢弃已不存在的勾选项
    const ids = new Set(state.rows.map((r) => r.id));
    for (const id of [...state.merge.selected]) {
      if (!ids.has(id)) state.merge.selected.delete(id);
    }
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

async function loadMerges() {
  if (!state.token) return;
  try {
    state.merges = await api("/api/merge-records");
  } catch {
    // 流水加载失败不阻塞主流程
  }
  m.redraw();
}

async function pollTick() {
  await loadReadings();
  if (state.page === "merge") await loadMerges();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(pollTick, 3000);
}

function resetMergeState() {
  state.merge.selected = new Set();
  state.merge.preview = null;
  state.merge.error = "";
  state.merge.msg = "";
}

// ---- 合成均值专页 ----

const MergePage = {
  oninit() {
    resetMergeState();
    loadMerges();
  },
  view() {
    const isWriter = state.user?.role === "writer";
    const mg = state.merge;
    const doneRows = state.rows.filter((r) => r.status === "done");
    const canPreview = mg.selected.size >= 2 && !mg.busy;

    async function preview() {
      mg.error = "";
      mg.msg = "";
      mg.preview = null;
      mg.busy = true;
      try {
        mg.preview = await api("/api/readings/merge-preview", {
          method: "POST",
          body: JSON.stringify({ reading_ids: [...mg.selected] }),
        });
      } catch (err) {
        mg.error = err.message || "预览失败";
      } finally {
        mg.busy = false;
        m.redraw();
      }
    }

    async function submitMerge() {
      mg.error = "";
      mg.msg = "";
      mg.busy = true;
      try {
        const data = await api("/api/readings/merge", {
          method: "POST",
          body: JSON.stringify({ reading_ids: [...mg.selected] }),
        });
        mg.msg = data.message || "已合成入队";
        mg.selected = new Set();
        mg.preview = null;
        await Promise.all([loadReadings(), loadMerges()]);
      } catch (err) {
        mg.error = err.message || "合成入队失败";
      } finally {
        mg.busy = false;
        m.redraw();
      }
    }

    return [
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "合成均值入队"),
        m(
          "p.sub",
          { style: { marginBottom: "0.75rem" } },
          "勾选至少两个已办结的同类（同跨段）测点，由服务端计算均值并写入新的候审单；前端不参与平均计算。"
        ),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "勾选"),
              m("th", "编号"),
              m("th", "跨段"),
              m("th", "微应变"),
              m("th", "结论"),
              m("th", "提交人"),
            ]),
          ]),
          m(
            "tbody",
            doneRows.length
              ? doneRows.map((r) =>
                  m("tr", { key: r.id }, [
                    m("td", [
                      m("input", {
                        type: "checkbox",
                        style: { minWidth: 0 },
                        checked: mg.selected.has(r.id),
                        onchange: (e) => {
                          if (e.target.checked) mg.selected.add(r.id);
                          else mg.selected.delete(r.id);
                          // 勾选变化后旧预览作废，需重新向服务端预览
                          mg.preview = null;
                          mg.error = "";
                        },
                      }),
                    ]),
                    m("td", r.id),
                    m("td", r.span_code),
                    m("td", `${r.microstrain} με`),
                    m("td", [
                      m(
                        "span",
                        { class: verdictClass(r.verdict, r.status) },
                        displayVerdict(r)
                      ),
                    ]),
                    m("td", r.created_by),
                  ])
                )
              : [m("tr", m("td", { colspan: 6 }, "暂无已办结测点"))]
          ),
        ]),
        m(
          "div.row",
          { style: { marginTop: "0.75rem" } },
          [
            m(
              "button",
              {
                type: "button",
                disabled: !canPreview,
                title: mg.selected.size < 2 ? "至少勾选两个测点" : "",
                onclick: preview,
              },
              "预览服务端均值"
            ),
            isWriter
              ? m(
                  "button",
                  {
                    type: "button",
                    disabled: !mg.preview || mg.busy,
                    title: !mg.preview ? "请先预览服务端均值" : "",
                    onclick: submitMerge,
                  },
                  "合成均值并入候审队列"
                )
              : m(
                  "p.sub",
                  { style: { margin: 0 } },
                  "复核员仅可预览均值，不能入队。"
                ),
            mg.selected.size < 2
              ? m("p.sub", { style: { margin: 0 } }, `已勾选 ${mg.selected.size} 个，至少需要 2 个`)
              : m("p.ok", { style: { margin: 0 } }, `已勾选 ${mg.selected.size} 个已办结测点`),
          ]
        ),
        mg.error ? m("p.err", mg.error) : null,
        mg.msg ? m("p.ok", mg.msg) : null,
        mg.preview
          ? m(
              "div.preview",
              { style: { marginTop: "0.75rem" } },
              [
                m("strong", "服务端均值预览"),
                m(
                  "p",
                  { style: { margin: "0.35rem 0" } },
                  `跨段：${mg.preview.span_code} · 测点 ${mg.preview.count} 笔 · 均值 ${mg.preview.mean_microstrain} με`
                ),
                m(
                  "p.sub",
                  { style: { margin: 0, fontSize: "0.85rem" } },
                  "来源：" +
                    mg.preview.sources
                      .map((s) => `#${s.id}(${s.microstrain}με)`)
                      .join("、")
                ),
              ]
            )
          : null,
      ]),
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "合成流水"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "流水号"),
              m("th", "来源测点"),
              m("th", "跨段"),
              m("th", "服务端均值"),
              m("th", "新候审单"),
              m("th", "操作人"),
              m("th", "时间"),
            ]),
          ]),
          m(
            "tbody",
            state.merges.length
              ? state.merges.map((g) =>
                  m("tr", { key: g.id }, [
                    m("td", g.id),
                    m("td", g.source_ids.map((id) => `#${id}`).join("、")),
                    m("td", g.span_code),
                    m("td", `${g.mean_microstrain} με`),
                    m("td", `#${g.new_reading_id}`),
                    m("td", g.created_by),
                    m("td", g.created_at ? g.created_at.replace("T", " ").slice(0, 19) : "—"),
                  ])
                )
              : [m("tr", m("td", { colspan: 7 }, "暂无合成流水"))]
          ),
        ]),
      ]),
    ];
  },
};

// ---- 读数列表页 ----

const ListPage = {
  view() {
    const isWriter = state.user?.role === "writer";
    return [
      isWriter
        ? m("div.card", [
            m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.msg = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/readings", {
                      method: "POST",
                      body: JSON.stringify({
                        span_code: state.submitForm.span_code,
                        microstrain: parseFloat(state.submitForm.microstrain),
                      }),
                    });
                    state.msg = data.message || "已提交";
                    state.submitForm = { span_code: "", microstrain: "" };
                    await loadReadings();
                  } catch (err) {
                    state.error = err.message || "提交失败";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "跨段编号",
                    m("input", {
                      required: true,
                      placeholder: "例如 跨中S3",
                      value: state.submitForm.span_code,
                      oninput: (e) => {
                        state.submitForm.span_code = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "微应变（με）",
                    m("input", {
                      required: true,
                      type: "number",
                      step: "0.1",
                      value: state.submitForm.microstrain,
                      oninput: (e) => {
                        state.submitForm.microstrain = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "提交"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
                state.msg ? m("p.ok", state.msg) : null,
              ]
            ),
          ])
        : null,
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "编号"),
              m("th", "跨段"),
              m("th", "微应变"),
              m("th", "结论"),
              m("th", "说明"),
              m("th", "状态"),
              m("th", "提交人"),
            ]),
          ]),
          m(
            "tbody",
            state.rows.length
              ? state.rows.map((r) =>
                  m("tr", { key: r.id, class: r.merged ? "merged-row" : "" }, [
                    m("td", r.id),
                    m("td", [
                      r.span_code,
                      r.merged
                        ? m(
                            "span",
                            {
                              class: "tag merge",
                              title: `合成流水 #${r.merge_id}`,
                              style: { marginLeft: "0.4rem" },
                            },
                            `合成#${r.merge_id}`
                          )
                        : null,
                    ]),
                    m("td", `${r.microstrain} με`),
                    m("td", [
                      m(
                        "span",
                        { class: verdictClass(r.verdict, r.status) },
                        displayVerdict(r)
                      ),
                    ]),
                    m("td", r.reason || "—"),
                    m("td", r.status === "pending" ? "待处理" : r.status === "processing" ? "处理中" : r.status),
                    m("td", r.created_by),
                  ])
                )
              : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
          ),
        ]),
      ]),
    ];
  },
};

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
          ),
          m("div.card", [
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/auth/login", {
                      method: "POST",
                      body: JSON.stringify(state.loginForm),
                    });
                    state.token = data.access_token;
                    state.user = { username: data.username, role: data.role };
                    localStorage.setItem(TOKEN_KEY, state.token);
                    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
                    state.page = "list";
                    await loadReadings();
                    startPolling();
                  } catch {
                    state.error = "用户名或密码错误";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "用户名",
                    m("input", {
                      value: state.loginForm.username,
                      oninput: (e) => {
                        state.loginForm.username = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "密码",
                    m("input", {
                      type: "password",
                      value: state.loginForm.password,
                      oninput: (e) => {
                        state.loginForm.password = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
              ]
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
            ),
          ]),
        ]
      );
    }

    const isWriter = state.user?.role === "writer";

    function logout() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      state.token = "";
      state.user = null;
      state.rows = [];
      state.page = "list";
      resetMergeState();
      if (state.timer) clearInterval(state.timer);
      m.redraw();
    }

    function switchPage(page) {
      state.page = page;
      if (page === "merge") loadMerges();
    }

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          m(
            "button.secondary",
            {
              type: "button",
              class: state.page === "list" ? "nav active" : "nav",
              style: { marginRight: "0.5rem" },
              onclick: () => switchPage("list"),
            },
            "读数列表"
          ),
          m(
            "button.secondary",
            {
              type: "button",
              class: state.page === "merge" ? "nav active" : "nav",
              style: { marginRight: "0.75rem" },
              onclick: () => switchPage("merge"),
            },
            "合成均值"
          ),
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            { type: "button", onclick: logout },
            "退出"
          ),
        ]),
      ]),
      state.page === "merge" ? m(MergePage) : m(ListPage),
    ]);
  },
};

export default App;
