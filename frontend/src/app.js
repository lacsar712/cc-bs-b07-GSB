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
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  page: "list",
  comp: {
    selected: new Set(),
    lockedSpan: null,
    preview: null,
    error: "",
    msg: "",
    loading: false,
    previewTimer: null,
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
    const rows = await api("/api/readings");
    state.rows = rows;
    // 列表刷新后剔除已不存在或不再是已办结的勾选项
    const doneIds = new Set(rows.filter((r) => r.status === "done").map((r) => r.id));
    let changed = false;
    for (const id of [...state.comp.selected]) {
      if (!doneIds.has(id)) {
        state.comp.selected.delete(id);
        changed = true;
      }
    }
    if (changed && state.comp.selected.size === 0) state.comp.lockedSpan = null;
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadReadings, 3000);
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.page = "list";
  if (state.timer) clearInterval(state.timer);
  if (state.comp.previewTimer) clearTimeout(state.comp.previewTimer);
  state.comp.selected = new Set();
  state.comp.lockedSpan = null;
  state.comp.preview = null;
  state.comp.error = "";
  state.comp.msg = "";
  m.redraw();
}

/* ---------- 合成均值专页 ---------- */

function doneGroups() {
  const groups = new Map();
  for (const r of state.rows) {
    if (r.status !== "done") continue;
    if (!groups.has(r.span_code)) groups.set(r.span_code, []);
    groups.get(r.span_code).push(r);
  }
  return [...groups.entries()].map(([span_code, items]) => ({
    span_code,
    items: items.sort((a, b) => a.id - b.id),
  }));
}

function schedulePreview() {
  const comp = state.comp;
  if (comp.previewTimer) clearTimeout(comp.previewTimer);
  comp.preview = null;
  comp.error = "";
  if (comp.selected.size < 2) {
    m.redraw();
    return;
  }
  comp.previewTimer = setTimeout(async () => {
    comp.loading = true;
    m.redraw();
    try {
      comp.preview = await api("/api/readings/composite/preview", {
        method: "POST",
        body: JSON.stringify({ ids: [...comp.selected] }),
      });
      comp.error = "";
    } catch (err) {
      comp.preview = null;
      comp.error = err.message || "预览失败";
    } finally {
      comp.loading = false;
      m.redraw();
    }
  }, 300);
}

function toggleSelect(row) {
  const comp = state.comp;
  if (comp.selected.has(row.id)) {
    comp.selected.delete(row.id);
    if (comp.selected.size === 0) comp.lockedSpan = null;
  } else {
    // 同类约束：已锁定其他跨段时不允许勾选（挡回由服务端兜底）
    if (comp.lockedSpan && comp.lockedSpan !== row.span_code) return;
    comp.selected.add(row.id);
    comp.lockedSpan = row.span_code;
  }
  comp.msg = "";
  schedulePreview();
}

async function enqueueComposite() {
  const comp = state.comp;
  comp.msg = "";
  comp.error = "";
  if (comp.selected.size < 2) {
    comp.error = "至少勾选两个测点才能合成均值";
    return;
  }
  comp.loading = true;
  try {
    const data = await api("/api/readings/composite", {
      method: "POST",
      body: JSON.stringify({ ids: [...comp.selected] }),
    });
    comp.msg =
      data.message ||
      `新单 #${data.id} 已按服务端均值 ${data.microstrain} με 入候审队`;
    comp.selected = new Set();
    comp.lockedSpan = null;
    comp.preview = null;
    await loadReadings();
  } catch (err) {
    comp.error = err.message || "入队失败";
  } finally {
    comp.loading = false;
    m.redraw();
  }
}

const CompositePage = {
  view() {
    const isWriter = state.user?.role === "writer";
    const comp = state.comp;
    const groups = doneGroups();

    return m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "合成均值入队"),
      m(
        "p.sub",
        { style: { marginBottom: "0.75rem" } },
        "勾选至少两个同一跨段的已办结测点，均值由服务端计算并写入新的候审单；前端不参与平均。"
      ),
      isWriter
        ? null
        : m(
            "p.note",
            "当前为复核员账号：可勾选测点并预览均值，但不能入队。"
          ),
      groups.length
        ? groups.map((g) =>
            m("div.comp-group", { key: g.span_code }, [
              m("h3", `跨段：${g.span_code}（已办结 ${g.items.length} 笔）`),
              m(
                "ul.comp-list",
                g.items.map((r) => {
                  const checked = comp.selected.has(r.id);
                  const disabledBySpan =
                    !checked && comp.lockedSpan && comp.lockedSpan !== g.span_code;
                  return m("li", { key: r.id, class: disabledBySpan ? "disabled" : "" }, [
                    m("label.check", [
                      m("input", {
                        type: "checkbox",
                        checked,
                        disabled: !!disabledBySpan,
                        onchange: () => toggleSelect(r),
                      }),
                      m(
                        "span",
                        `#${r.id}　${r.microstrain} με　`
                      ),
                      m("span", { class: verdictClass(r.verdict, r.status) }, r.verdict || "—"),
                      r.composed_from && r.composed_from.length
                        ? m("span.comp-src", `（合成自 #${r.composed_from.join("、#")}）`)
                        : null,
                    ]),
                  ]);
                })
              ),
            ])
          )
        : m("p.sub", "暂无可合成的已办结测点。"),

      m("div.comp-preview", [
        m("h3", "均值预览"),
        comp.selected.size < 2
          ? m(
              "p.sub",
              { style: { marginBottom: 0 } },
              `已勾选 ${comp.selected.size} 个测点，至少勾选两个同类已办结测点后显示服务端均值。`
            )
          : comp.loading
            ? m("p.sub", { style: { marginBottom: 0 } }, "正在向服务端请求均值…")
            : comp.preview
              ? m("div", [
                  m(
                    "p",
                    { style: { margin: "0 0 0.35rem" } },
                    `跨段 ${comp.preview.span_code}　测点 ${comp.preview.count} 笔（#${comp.preview.source_ids.join("、#")}）`
                  ),
                  m("p.mean", { style: { margin: "0 0 0.35rem" } }, [
                    "服务端均值：",
                    m("strong", `${comp.preview.mean_microstrain} με`),
                  ]),
                ])
              : null,
        comp.error ? m("p.err", comp.error) : null,
        comp.msg ? m("p.ok", comp.msg) : null,
        isWriter
          ? m(
              "button",
              {
                type: "button",
                disabled: comp.loading || comp.selected.size < 2,
                onclick: enqueueComposite,
                style: { marginTop: "0.5rem" },
              },
              "按均值入队"
            )
          : null,
      ]),
    ]);
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

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            { type: "button", onclick: logout },
            "退出"
          ),
        ]),
      ]),
      m("div.nav", [
        m(
          "button.navbtn" + (state.page === "list" ? ".active" : ""),
          {
            type: "button",
            onclick: () => {
              state.page = "list";
            },
          },
          "读数列表"
        ),
        m(
          "button.navbtn" + (state.page === "composite" ? ".active" : ""),
          {
            type: "button",
            onclick: () => {
              state.page = "composite";
            },
          },
          "合成均值"
        ),
      ]),
      state.page === "composite"
        ? m(CompositePage)
        : [
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
                    m("th", "来源"),
                  ]),
                ]),
                m(
                  "tbody",
                  state.rows.length
                    ? state.rows.map((r) =>
                        m("tr", { key: r.id }, [
                          m("td", r.id),
                          m("td", r.span_code),
                          m("td", r.microstrain),
                          m("td", [
                            m(
                              "span",
                              { class: verdictClass(r.verdict, r.status) },
                              displayVerdict(r)
                            ),
                          ]),
                          m("td", r.reason || "—"),
                          m("td", r.status),
                          m("td", r.created_by),
                          m(
                            "td",
                            r.composed_from && r.composed_from.length
                              ? m("span.comp-src", `合成自 #${r.composed_from.join("、#")}`)
                              : "—"
                          ),
                        ])
                      )
                    : [m("tr", m("td", { colspan: 8 }, "暂无数据"))]
                ),
              ]),
            ]),
          ],
    ]);
  },
};

export default App;
