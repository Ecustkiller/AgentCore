module.exports = [
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[project]/apps/website/src/components/agentmap/shared.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * 「多 Agent 协作作战地图」共享积木：角色数据 + 纯展示 SVG 基元。
 *
 * 两种舞台共用这套基元：
 * - `AgentWarMapWide`（整宽横向系统地图，方案②）
 * - `AgentWarMapPortrait`（加宽右栏的竖向地图，方案①）
 *
 * 体现产品真实机制：CEO + delegate 定 DAG、WaveScheduler 波次调度、共享工作区中转产物、
 * A2A 辩论/互审、worker 阻塞 escalate 升级给你、CEO 波边界 replan、MCP 工具调用、跨会话记忆。
 * 颜色只用语义 token / Agent 身份色（globals.css 单一来源），不硬编码 hex。
 */ __turbopack_context__.s([
    "AGENTS",
    ()=>AGENTS,
    "AgentChip",
    ()=>AgentChip,
    "CommEdge",
    ()=>CommEdge,
    "EscalationEdge",
    ()=>EscalationEdge,
    "FlowEdge",
    ()=>FlowEdge,
    "HubNode",
    ()=>HubNode,
    "MapDefs",
    ()=>MapDefs,
    "SharedWorkspace",
    ()=>SharedWorkspace,
    "StatusRing",
    ()=>StatusRing,
    "TokenDot",
    ()=>TokenDot,
    "ToolChip",
    ()=>ToolChip,
    "ToolGlyph",
    ()=>ToolGlyph,
    "WaveTag",
    ()=>WaveTag,
    "YouNode",
    ()=>YouNode,
    "statusColor",
    ()=>statusColor
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
;
const AGENTS = {
    market: {
        title: "市场检索",
        color: "--agent-1",
        status: "done",
        tool: "web"
    },
    comp: {
        title: "竞品采集",
        color: "--agent-2",
        status: "done",
        tool: "web"
    },
    interview: {
        title: "用户访谈",
        color: "--agent-3",
        status: "blocked",
        tool: "files"
    },
    data: {
        title: "数据分析",
        color: "--agent-4",
        status: "running",
        tool: "code"
    },
    persona: {
        title: "用户画像",
        color: "--agent-5",
        status: "running",
        tool: "db"
    },
    pro: {
        title: "方案 · 正",
        color: "--agent-7",
        status: "pending"
    },
    con: {
        title: "方案 · 反",
        color: "--agent-8",
        status: "pending"
    },
    review: {
        title: "评审",
        color: "--agent-6",
        status: "pending",
        tool: "files"
    }
};
function statusColor(s) {
    if (s === "done") return "var(--success)";
    if (s === "running") return "var(--primary)";
    if (s === "blocked") return "var(--warning)";
    return "var(--muted-foreground)";
}
const TOOL_LABEL = {
    web: "Web",
    db: "DB",
    files: "Files",
    code: "Code"
};
function MapDefs({ idPrefix }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("defs", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("marker", {
                id: `${idPrefix}-arrow`,
                viewBox: "0 0 10 10",
                refX: "9",
                refY: "5",
                markerWidth: "7",
                markerHeight: "7",
                orient: "auto-start-reverse",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M0,0 L10,5 L0,10 z",
                    fill: "var(--primary)",
                    fillOpacity: "0.85"
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 68,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 59,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("marker", {
                id: `${idPrefix}-arrow-amber`,
                viewBox: "0 0 10 10",
                refX: "9",
                refY: "5",
                markerWidth: "7",
                markerHeight: "7",
                orient: "auto-start-reverse",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: "M0,0 L10,5 L0,10 z",
                    fill: "var(--warning)",
                    fillOpacity: "0.9"
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 79,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 70,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("marker", {
                id: `${idPrefix}-dot`,
                viewBox: "0 0 6 6",
                refX: "3",
                refY: "3",
                markerWidth: "6",
                markerHeight: "6",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                    cx: "3",
                    cy: "3",
                    r: "2.2",
                    fill: "var(--brand-2)",
                    fillOpacity: "0.8"
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 89,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 81,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 58,
        columnNumber: 5
    }, this);
}
function FlowEdge({ d, idPrefix, label }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: d,
                fill: "none",
                stroke: "var(--primary)",
                strokeOpacity: 0.32,
                strokeWidth: 1.6,
                markerEnd: `url(#${idPrefix}-arrow)`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 107,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                className: "am-flow",
                d: d,
                fill: "none",
                stroke: "var(--primary)",
                strokeOpacity: 0.9,
                strokeWidth: 1.8
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 115,
                columnNumber: 7
            }, this),
            label ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(EdgeLabel, {
                d: d,
                text: label
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 123,
                columnNumber: 16
            }, this) : null
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 106,
        columnNumber: 5
    }, this);
}
function CommEdge({ d, idPrefix }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
        className: "am-comm",
        d: d,
        fill: "none",
        stroke: "var(--brand-2)",
        strokeOpacity: 0.7,
        strokeWidth: 1.5,
        markerStart: `url(#${idPrefix}-dot)`,
        markerEnd: `url(#${idPrefix}-dot)`
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 131,
        columnNumber: 5
    }, this);
}
function EscalationEdge({ d, idPrefix }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
        className: "am-blink",
        d: d,
        fill: "none",
        stroke: "var(--warning)",
        strokeOpacity: 0.9,
        strokeWidth: 1.6,
        strokeDasharray: "2 5",
        strokeLinecap: "round",
        markerEnd: `url(#${idPrefix}-arrow-amber)`
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 153,
        columnNumber: 5
    }, this);
}
function TokenDot({ path, color = "var(--brand-2)", dur = 3.2, delay = 0, r = 3 }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
        className: "am-token",
        r: r,
        fill: color,
        style: {
            offsetPath: `path('${path}')`,
            animationDuration: `${dur}s`,
            animationDelay: `${delay}s`
        }
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 182,
        columnNumber: 5
    }, this);
}
function EdgeLabel({ d, text }) {
    // 取路径中点的粗略估计：用首尾坐标平均（直线/浅弧足够）。
    const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const x1 = nums[0] ?? 0;
    const y1 = nums[1] ?? 0;
    const x2 = nums[nums.length - 2] ?? x1;
    const y2 = nums[nums.length - 1] ?? y1;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const w = text.length * 12 + 10;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: cx - w / 2,
                y: cy - 9,
                width: w,
                height: 18,
                rx: 5,
                fill: "var(--background)",
                fillOpacity: 0.9
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 207,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: cx,
                y: cy + 4,
                textAnchor: "middle",
                fontSize: 11,
                fill: "var(--muted-foreground)",
                children: text
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 216,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 206,
        columnNumber: 5
    }, this);
}
function StatusRing({ cx, cy, status, r = 7 }) {
    const color = statusColor(status);
    if (status === "running") {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
            className: "am-spin",
            cx: cx,
            cy: cy,
            r: r,
            fill: "none",
            stroke: color,
            strokeWidth: 2,
            strokeDasharray: "3 3.5"
        }, void 0, false, {
            fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
            lineNumber: 243,
            columnNumber: 7
        }, this);
    }
    if (status === "done") {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                    cx: cx,
                    cy: cy,
                    r: r,
                    fill: color,
                    fillOpacity: 0.18
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 258,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                    cx: cx,
                    cy: cy,
                    r: r,
                    fill: "none",
                    stroke: color,
                    strokeWidth: 1.6
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 259,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                    d: `M${cx - 3.2} ${cy} l2.2 2.3 l4.2 -4.6`,
                    fill: "none",
                    stroke: color,
                    strokeWidth: 1.6,
                    strokeLinecap: "round",
                    strokeLinejoin: "round"
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 260,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
            lineNumber: 257,
            columnNumber: 7
        }, this);
    }
    if (status === "blocked") {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
            className: "am-blink",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                    cx: cx,
                    cy: cy,
                    r: r,
                    fill: color,
                    fillOpacity: 0.2
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 274,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                    cx: cx,
                    cy: cy,
                    r: r,
                    fill: "none",
                    stroke: color,
                    strokeWidth: 1.6
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 275,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("line", {
                    x1: cx,
                    y1: cy - 3,
                    x2: cx,
                    y2: cy + 1,
                    stroke: color,
                    strokeWidth: 1.7,
                    strokeLinecap: "round"
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 276,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                    cx: cx,
                    cy: cy + 3.4,
                    r: 0.9,
                    fill: color
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 285,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
            lineNumber: 273,
            columnNumber: 7
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
        cx: cx,
        cy: cy,
        r: r,
        fill: "none",
        stroke: color,
        strokeOpacity: 0.55,
        strokeWidth: 1.6,
        strokeDasharray: "2 3"
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 290,
        columnNumber: 5
    }, this);
}
function ToolGlyph({ cx, cy, kind, size = 13, color = "var(--muted-foreground)" }) {
    const s = size / 2;
    const common = {
        fill: "none",
        stroke: color,
        strokeWidth: 1.4,
        strokeLinecap: "round",
        strokeLinejoin: "round"
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        transform: `translate(${cx} ${cy})`,
        children: [
            kind === "web" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                ...common,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                        cx: 0,
                        cy: 0,
                        r: s
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 328,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ellipse", {
                        cx: 0,
                        cy: 0,
                        rx: s / 2.2,
                        ry: s
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 329,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("line", {
                        x1: -s,
                        y1: 0,
                        x2: s,
                        y2: 0
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 330,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 327,
                columnNumber: 9
            }, this),
            kind === "db" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                ...common,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ellipse", {
                        cx: 0,
                        cy: -s + 1.5,
                        rx: s,
                        ry: s / 2.4
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 335,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${-s} ${-s + 1.5} V${s - 1.5}`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 336,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${s} ${-s + 1.5} V${s - 1.5}`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 337,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${-s} ${s - 1.5} A${s} ${s / 2.4} 0 0 0 ${s} ${s - 1.5}`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 338,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${-s} ${0} A${s} ${s / 2.4} 0 0 0 ${s} ${0}`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 339,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 334,
                columnNumber: 9
            }, this),
            kind === "files" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                ...common,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${-s + 1} ${-s} h${size - 4} l2 2 v${size - 2} h${-size} z`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 344,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("line", {
                        x1: -s + 3,
                        y1: -1,
                        x2: s - 3,
                        y2: -1
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 347,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("line", {
                        x1: -s + 3,
                        y1: s - 3,
                        x2: s - 3,
                        y2: s - 3
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 348,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 343,
                columnNumber: 9
            }, this),
            kind === "code" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                ...common,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${-s + 1} ${-s + 2} L${-s + 4} ${0} L${-s + 1} ${s - 2}`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 353,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                        d: `M${s - 1} ${-s + 2} L${s - 4} ${0} L${s - 1} ${s - 2}`
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 354,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 352,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 325,
        columnNumber: 5
    }, this);
}
function YouNode({ x, y, w, h, sub }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x - 4,
                y: y - 4,
                width: w + 8,
                height: h + 8,
                rx: 16,
                fill: "none",
                stroke: "var(--brand-2)",
                strokeOpacity: 0.35,
                strokeWidth: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 377,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y,
                width: w,
                height: h,
                rx: 12,
                fill: "var(--primary)",
                fillOpacity: 0.16,
                stroke: "var(--primary)",
                strokeWidth: 1.6
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 388,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: `M${x + w / 2 - 9} ${y + 13} l3 -7 l3 4 l3 -6 l3 6 l3 -4 l3 7 z`,
                fill: "var(--brand-2)",
                fillOpacity: 0.9
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 400,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + w / 2,
                y: sub ? y + h / 2 + 6 : y + h / 2 + 5,
                textAnchor: "middle",
                fontSize: 15,
                fontWeight: 700,
                fill: "var(--foreground)",
                children: "你"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 405,
                columnNumber: 7
            }, this),
            sub && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + w / 2,
                y: y + h - 8,
                textAnchor: "middle",
                fontSize: 10.5,
                fill: "var(--muted-foreground)",
                children: sub
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 416,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 376,
        columnNumber: 5
    }, this);
}
function HubNode({ x, y, w, h, title, sub }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x - 4,
                y: y - 4,
                width: w + 8,
                height: h + 8,
                rx: 16,
                fill: "none",
                stroke: "var(--primary)",
                strokeOpacity: 0.25,
                strokeWidth: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 448,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y,
                width: w,
                height: h,
                rx: 12,
                fill: "var(--card)",
                stroke: "var(--primary)",
                strokeWidth: 1.6
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 459,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + w / 2,
                y: sub ? y + h / 2 - 4 : y + h / 2 + 4,
                textAnchor: "middle",
                fontSize: 14,
                fontWeight: 700,
                fill: "var(--foreground)",
                children: title
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 469,
                columnNumber: 7
            }, this),
            sub && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + w / 2,
                y: y + h / 2 + 13,
                textAnchor: "middle",
                fontSize: 10.5,
                fill: "var(--muted-foreground)",
                children: sub
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 480,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 447,
        columnNumber: 5
    }, this);
}
function AgentChip({ x, y, w, h, agent, wave }) {
    const c = `var(${agent.color})`;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y,
                width: w,
                height: h,
                rx: 11,
                fill: "var(--card)",
                stroke: "var(--border)",
                strokeWidth: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 513,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y + 6,
                width: 4,
                height: h - 12,
                rx: 2,
                fill: c
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 524,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                cx: x + 16,
                cy: y + h / 2,
                r: 4.5,
                fill: c,
                fillOpacity: 0.9
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 525,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + 27,
                y: y + h / 2 + 4.5,
                fontSize: 13,
                fontWeight: 600,
                fill: "var(--foreground)",
                children: agent.title
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 526,
                columnNumber: 7
            }, this),
            wave ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                        cx: x,
                        cy: y,
                        r: 9.5,
                        fill: "var(--primary)"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 538,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                        x: x,
                        y: y + 3.5,
                        textAnchor: "middle",
                        fontSize: 10,
                        fontWeight: 700,
                        fill: "var(--primary-foreground)",
                        children: wave
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                        lineNumber: 539,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 537,
                columnNumber: 9
            }, this) : null,
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(StatusRing, {
                cx: x + w,
                cy: y,
                status: agent.status
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 552,
                columnNumber: 7
            }, this),
            agent.tool ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(ToolGlyph, {
                    cx: x + w - 13,
                    cy: y + h - 12,
                    kind: agent.tool
                }, void 0, false, {
                    fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                    lineNumber: 556,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 555,
                columnNumber: 9
            }, this) : null
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 512,
        columnNumber: 5
    }, this);
}
function ToolChip({ x, y, w, h, kind }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y,
                width: w,
                height: h,
                rx: 10,
                fill: "var(--card)",
                stroke: "var(--border)",
                strokeWidth: 1,
                strokeDasharray: "4 3"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 579,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(ToolGlyph, {
                cx: x + 16,
                cy: y + h / 2,
                kind: kind,
                size: 15
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 590,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + 28,
                y: y + h / 2 + 4,
                fontSize: 12,
                fill: "var(--muted-foreground)",
                children: TOOL_LABEL[kind]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 591,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 578,
        columnNumber: 5
    }, this);
}
function WaveTag({ x, y, text, anchor = "middle" }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
        x: x,
        y: y,
        textAnchor: anchor,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: "0.04em",
        fill: "var(--muted-foreground)",
        children: text
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 615,
        columnNumber: 5
    }, this);
}
function SharedWorkspace({ x, y, w, h, label = "共享工作区 · 产物经调度器中转" }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y,
                width: w,
                height: h,
                rx: 16,
                fill: "var(--primary)",
                fillOpacity: 0.04,
                stroke: "var(--primary)",
                strokeOpacity: 0.45,
                strokeWidth: 1.3,
                strokeDasharray: "7 5"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 644,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x + 14,
                y: y - 11,
                width: label.length * 11 + 22,
                height: 22,
                rx: 8,
                fill: "var(--card)",
                stroke: "var(--border)",
                strokeWidth: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 657,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + 25,
                y: y + 4,
                fontSize: 11.5,
                fontWeight: 600,
                fill: "var(--foreground)",
                children: label
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
                lineNumber: 667,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/shared.tsx",
        lineNumber: 643,
        columnNumber: 5
    }, this);
}
}),
"[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>AgentMapVerticalSimple
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/shared.tsx [app-rsc] (ecmascript)");
;
;
/**
 * 方案A —— 「简化竖图」：Hero 右栏用的极简协作概览。
 *
 * 设计取向：**2 秒看懂的主干叙事**，不是完整架构图。
 * 你 → CEO 组团 → 一支团队在共享工作区分 3 波协作（每波两路、列对齐、零交叉）→ CEO 综合 → 你。
 * 刻意省略：工具层 / 跨会话记忆 / 阻塞升级 / 状态环 —— 这些机制细节交给下方专区或完整版。
 * 保留：身份色队员卡、波次徽标、波内 A2A 协作虚线（产品差异化的「辩论 / 互审」）。
 *
 * 连线全部沿两条竖直泳道（左 128 / 右 332）平行下行，仅在 CEO 扇出、CEO 综合扇入处汇聚——
 * 同源扇出 / 同汇扇入不产生交叉，从根上避免「蛛网」。颜色只用语义 token / 身份色。
 */ const LEFT = 128;
const RIGHT = 332;
const WAVE1 = [
    {
        title: "市场检索",
        color: "--agent-1",
        wave: 1
    },
    {
        title: "竞品采集",
        color: "--agent-2",
        wave: 1
    }
];
const WAVE2 = [
    {
        title: "数据分析",
        color: "--agent-4",
        wave: 2
    },
    {
        title: "用户画像",
        color: "--agent-5",
        wave: 2
    }
];
const WAVE3 = [
    {
        title: "方案 · 正",
        color: "--agent-7",
        wave: 3
    },
    {
        title: "方案 · 反",
        color: "--agent-8",
        wave: 3
    }
];
function RoleChip({ x, y, w, h, role }) {
    const c = `var(${role.color})`;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y,
                width: w,
                height: h,
                rx: 11,
                fill: "var(--card)",
                stroke: "var(--border)",
                strokeWidth: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 49,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x,
                y: y + 6,
                width: 4,
                height: h - 12,
                rx: 2,
                fill: c
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 59,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                cx: x + 18,
                cy: y + h / 2,
                r: 4.5,
                fill: c,
                fillOpacity: 0.9
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 60,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x + 30,
                y: y + h / 2 + 4.5,
                fontSize: 13,
                fontWeight: 600,
                fill: "var(--foreground)",
                children: role.title
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 61,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("circle", {
                        cx: x + w - 13,
                        cy: y + 13,
                        r: 8.5,
                        fill: "var(--primary)",
                        fillOpacity: 0.16
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                        lineNumber: 72,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                        x: x + w - 13,
                        y: y + 16.5,
                        textAnchor: "middle",
                        fontSize: 9.5,
                        fontWeight: 700,
                        fill: "var(--primary)",
                        children: role.wave
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                        lineNumber: 73,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 71,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
        lineNumber: 48,
        columnNumber: 5
    }, this);
}
/** 任务流向：实线 + 箭头（平静，不做流动动画，凸显「简化」）。 */ function Flow({ d, idPrefix }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
        d: d,
        fill: "none",
        stroke: "var(--primary)",
        strokeOpacity: 0.55,
        strokeWidth: 1.6,
        markerEnd: `url(#${idPrefix}-arrow)`
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
        lineNumber: 97,
        columnNumber: 5
    }, this);
}
/** 波内 A2A 协作通信：双向虚线 + 端点。 */ function Comm({ d, idPrefix }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
        d: d,
        fill: "none",
        stroke: "var(--brand-2)",
        strokeOpacity: 0.6,
        strokeWidth: 1.5,
        strokeDasharray: "5 5",
        markerStart: `url(#${idPrefix}-dot)`,
        markerEnd: `url(#${idPrefix}-dot)`
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
        lineNumber: 111,
        columnNumber: 5
    }, this);
}
function Label({ x, y, text }) {
    const w = text.length * 13 + 12;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("g", {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: x - w / 2,
                y: y - 10,
                width: w,
                height: 20,
                rx: 6,
                fill: "var(--background)",
                fillOpacity: 0.92
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 128,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: x,
                y: y + 4,
                textAnchor: "middle",
                fontSize: 12,
                fill: "var(--muted-foreground)",
                children: text
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 137,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
        lineNumber: 127,
        columnNumber: 5
    }, this);
}
function AgentMapVerticalSimple() {
    const P = "vs";
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
        viewBox: "0 0 460 612",
        className: "h-auto w-full",
        role: "img",
        "aria-label": "一次协作的简化概览：你下达目标，CEO 主 Agent 组建团队并委派；团队在共享工作区分三波协作——波次1 市场检索与竞品采集并行，波次2 数据分析与用户画像依赖前一波，波次3 方案正反辩论互审；最终 CEO 综合裁决回到你审阅",
        style: {
            fontFamily: "inherit"
        },
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["MapDefs"], {
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 160,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: 24,
                y: 196,
                width: 412,
                height: 258,
                rx: 16,
                fill: "var(--primary)",
                fillOpacity: 0.04,
                stroke: "var(--primary)",
                strokeOpacity: 0.45,
                strokeWidth: 1.3,
                strokeDasharray: "7 5"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 163,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("rect", {
                x: 24,
                y: 185,
                width: 108,
                height: 22,
                rx: 8,
                fill: "var(--card)",
                stroke: "var(--border)",
                strokeWidth: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 176,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: 78,
                y: 200,
                textAnchor: "middle",
                fontSize: 11.5,
                fontWeight: 600,
                fill: "var(--foreground)",
                children: "共享工作区"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 186,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: "M230 66 L230 90",
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 198,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M230 160 C 195 178 ${LEFT + 8} 196 ${LEFT} 245`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 199,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M230 160 C 265 178 ${RIGHT - 8} 196 ${RIGHT} 245`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 200,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M${LEFT} 289 L${LEFT} 305`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 201,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M${RIGHT} 289 L${RIGHT} 305`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 202,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M${LEFT} 347 L${LEFT} 363`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 203,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M${RIGHT} 347 L${RIGHT} 363`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 204,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M${LEFT} 405 C 165 430 208 442 228 450`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 205,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: `M${RIGHT} 405 C 295 430 252 442 232 450`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 206,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: "M230 458 L230 478",
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 207,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Flow, {
                d: "M230 540 L230 560",
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 208,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Comm, {
                d: `M${LEFT + 88} 268 L${RIGHT - 88} 268`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 211,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Comm, {
                d: `M${LEFT + 88} 326 L${RIGHT - 88} 326`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 212,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Comm, {
                d: `M${LEFT + 88} 384 L${RIGHT - 88} 384`,
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 213,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Label, {
                x: 230,
                y: 178,
                text: "委派"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 216,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Label, {
                x: 230,
                y: 384,
                text: "辩论 · 互审"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 217,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["YouNode"], {
                x: 170,
                y: 20,
                w: 120,
                h: 46,
                sub: "下达目标"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 220,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 150,
                y: 94,
                w: 160,
                h: 62,
                title: "CEO 主 Agent",
                sub: "组团 · 委派 · 编排"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 221,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(RoleChip, {
                x: 40,
                y: 247,
                w: 176,
                h: 42,
                role: WAVE1[0]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 230,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(RoleChip, {
                x: 244,
                y: 247,
                w: 176,
                h: 42,
                role: WAVE1[1]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 231,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(RoleChip, {
                x: 40,
                y: 305,
                w: 176,
                h: 42,
                role: WAVE2[0]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 232,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(RoleChip, {
                x: 244,
                y: 305,
                w: 176,
                h: 42,
                role: WAVE2[1]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 233,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(RoleChip, {
                x: 40,
                y: 363,
                w: 176,
                h: 42,
                role: WAVE3[0]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 234,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(RoleChip, {
                x: 244,
                y: 363,
                w: 176,
                h: 42,
                role: WAVE3[1]
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 235,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 150,
                y: 478,
                w: 160,
                h: 60,
                title: "CEO 综合",
                sub: "裁决 · 汇报"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 237,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["YouNode"], {
                x: 170,
                y: 560,
                w: 120,
                h: 44,
                sub: "审阅 · 决策"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
                lineNumber: 238,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx",
        lineNumber: 153,
        columnNumber: 5
    }, this);
}
}),
"[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>AgentWarMapPortrait
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/shared.tsx [app-rsc] (ecmascript)");
;
;
/**
 * 方案B —— 完整竖向「多 Agent 协作作战地图」（Hero 右栏加宽版）。
 *
 * 与旧版差异（去蛛网手术）：
 * - 三列固定泳道（L/M/R），波次 2 的两张卡对齐左右列，不再偏置。
 * - 任务流向改「中心总线 + 正交折线」：CEO 扇出、波次间注入、CEO 综合扇入均走水平总线，列内竖直下行——零曲线交叉。
 * - 保留完整机制：8 队员、状态环、工具印记、跨会话记忆、阻塞升级、A2A 辩论/互审。
 */ /** 三列泳道中心 x（卡片宽 190，列间距对齐）。 */ const L = 135;
const M = 340;
const R = 545;
/** 波次行 y（卡片顶边）。 */ const Y1 = 238;
const Y2 = 336;
const Y3 = 434;
const CARD_H = 44;
/** 波次间水平总线 y。 */ const BUS_DELEGATE = 212;
const BUS_INJECT = 310;
const BUS_W2W3 = 408;
const BUS_MERGE = 518;
function AgentWarMapPortrait() {
    const P = "pm";
    const y1b = Y1 + CARD_H;
    const y2b = Y2 + CARD_H;
    const y3b = Y3 + CARD_H;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
        viewBox: "0 0 680 736",
        className: "h-auto w-full",
        role: "img",
        "aria-label": "多 Agent 协作作战地图（竖向）：你下达目标，CEO 主 Agent 用 delegate 定义 DAG 组团；共享工作区内分三波协作——波次1 市场检索/竞品采集/用户访谈并行，波次2 数据分析/用户画像依赖，波次3 方案正反辩论并经评审互审；各 Agent 经 MCP 调用工具（卡片右下角印记），用户访谈遇阻 escalate 升级给你，最终 CEO 综合裁决回到你审阅",
        style: {
            fontFamily: "inherit"
        },
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["MapDefs"], {
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 55,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SharedWorkspace"], {
                x: 24,
                y: 200,
                w: 632,
                h: 320
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 58,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 40,
                y: 228,
                text: "波次 1 · 并行",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 59,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 40,
                y: 326,
                text: "波次 2 · 依赖",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 60,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 40,
                y: 424,
                text: "波次 3 · 辩论 · 互审",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 61,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M340 72 L340 96"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 66,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M190 128 L255 128"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 69,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M340 160 L340 ${BUS_DELEGATE}`,
                label: "委派"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 72,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M340 ${BUS_DELEGATE} L${L} ${BUS_DELEGATE} L${L} ${Y1}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 73,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M340 ${BUS_DELEGATE} L${M} ${Y1}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 74,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M340 ${BUS_DELEGATE} L${R} ${BUS_DELEGATE} L${R} ${Y1}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 75,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${y1b} L${L} ${BUS_INJECT}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 78,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${M} ${y1b} L${M} ${BUS_INJECT}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 79,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${R} ${y1b} L${R} ${BUS_INJECT}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 80,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${BUS_INJECT} L${R} ${BUS_INJECT}`,
                label: "注入"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 81,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${BUS_INJECT} L${L} ${Y2}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 86,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${R} ${BUS_INJECT} L${R} ${Y2}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 87,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${y2b} L${L} ${BUS_W2W3} L${L} ${Y3}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 90,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${R} ${y2b} L${R} ${BUS_W2W3} L${R} ${Y3}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 91,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${M} ${BUS_W2W3} L${M} ${Y3}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 92,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${BUS_W2W3} L${R} ${BUS_W2W3}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 93,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${y3b} L${L} ${BUS_MERGE}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 96,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${M} ${y3b} L${M} ${BUS_MERGE}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 97,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${R} ${y3b} L${R} ${BUS_MERGE}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 98,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M${L} ${BUS_MERGE} L${R} ${BUS_MERGE}`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 99,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: `M340 ${BUS_MERGE} L340 556`,
                label: "综合"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 100,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M340 620 L340 660"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 103,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CommEdge"], {
                idPrefix: P,
                d: `M${L + 95} 456 L${M - 95} 456`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 106,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CommEdge"], {
                idPrefix: P,
                d: `M${M + 95} 456 L${R - 95} 456`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 107,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["EscalationEdge"], {
                idPrefix: P,
                d: `M${R} ${Y1 + CARD_H / 2} L${R + 52} ${Y1 + CARD_H / 2} L${R + 52} 44 L392 44`
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 110,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: R + 56,
                y: 140,
                fontSize: 10.5,
                fontWeight: 600,
                fill: "var(--warning)",
                children: "escalate 升级"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 114,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M340 72 L340 96",
                dur: 2.2,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 125,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: `M340 160 L340 ${BUS_DELEGATE} L${M} ${Y1}`,
                dur: 2.8,
                delay: 0.5,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 126,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: `M340 ${BUS_MERGE} L340 556`,
                dur: 3,
                delay: 1,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 132,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M340 620 L340 660",
                dur: 2.6,
                delay: 1.4,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 138,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["YouNode"], {
                x: 290,
                y: 16,
                w: 100,
                h: 56,
                sub: "下达目标"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 141,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 40,
                y: 110,
                w: 150,
                h: 36,
                title: "跨会话记忆"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 142,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 255,
                y: 96,
                w: 170,
                h: 64,
                title: "CEO 主 Agent",
                sub: "delegate · DAG · replan"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 143,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 40,
                y: Y1,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].market,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 153,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 245,
                y: Y1,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].comp,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 154,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 450,
                y: Y1,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].interview,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 155,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 40,
                y: Y2,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].data,
                wave: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 158,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 450,
                y: Y2,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].persona,
                wave: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 159,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 40,
                y: Y3,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].pro,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 162,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 245,
                y: Y3,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].con,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 163,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 450,
                y: Y3,
                w: 190,
                h: CARD_H,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].review,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 164,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 255,
                y: 556,
                w: 170,
                h: 64,
                title: "CEO 综合",
                sub: "裁决 · 汇报"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 166,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["YouNode"], {
                x: 290,
                y: 660,
                w: 100,
                h: 56,
                sub: "审阅 · 决策"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 174,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
        lineNumber: 48,
        columnNumber: 5
    }, this);
}
}),
"[project]/apps/website/src/app/preview/maps/page.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>MapsPreviewPage,
    "metadata",
    ()=>metadata
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentMapVerticalSimple$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/AgentMapVerticalSimple.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentWarMapPortrait$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx [app-rsc] (ecmascript)");
;
;
;
const metadata = {
    title: "协作图选型预览",
    robots: {
        index: false,
        follow: false
    }
};
function HeroCopy() {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "max-w-xl",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "eyebrow",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "inline-block h-1.5 w-1.5 rounded-full bg-primary"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 19,
                        columnNumber: 9
                    }, this),
                    "协作智能平台"
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 18,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                className: "mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "text-gradient",
                        children: "协作，"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 23,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("br", {}, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 24,
                        columnNumber: 9
                    }, this),
                    "是更高级的智能"
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 22,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "mt-6 text-lg leading-relaxed text-muted-foreground",
                children: "一句需求，CEO 主 Agent 自动组建团队，按依赖关系分波次推进—— 串行、并行、辩论、互审，全程可见。"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 27,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "mt-8 flex flex-wrap gap-3",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "btn btn-primary",
                        children: "下载客户端"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 32,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "btn btn-ghost",
                        children: "看团队如何协作"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 33,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 31,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
        lineNumber: 17,
        columnNumber: 5
    }, this);
}
function WaveLegend() {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "inline-flex shrink-0 items-center gap-1.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                        width: "22",
                        height: "8",
                        viewBox: "0 0 22 8",
                        "aria-hidden": "true",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("line", {
                                x1: "1",
                                y1: "4",
                                x2: "15",
                                y2: "4",
                                stroke: "var(--primary)",
                                strokeOpacity: 0.7,
                                strokeWidth: 1.6
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 44,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("polygon", {
                                points: "15,1 21,4 15,7",
                                fill: "var(--primary)",
                                fillOpacity: 0.7
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 45,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 43,
                        columnNumber: 9
                    }, this),
                    "任务流向"
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 42,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "inline-flex shrink-0 items-center gap-1.5",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                        width: "22",
                        height: "8",
                        viewBox: "0 0 22 8",
                        "aria-hidden": "true",
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("line", {
                            x1: "4",
                            y1: "4",
                            x2: "18",
                            y2: "4",
                            stroke: "var(--brand-2)",
                            strokeOpacity: 0.6,
                            strokeWidth: 1.6,
                            strokeDasharray: "4 3"
                        }, void 0, false, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 51,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 50,
                        columnNumber: 9
                    }, this),
                    "协作通信"
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 49,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                className: "min-w-0",
                children: "波次 ①并行 ②依赖 ③辩论"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 55,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
        lineNumber: 41,
        columnNumber: 5
    }, this);
}
function MapsPreviewPage() {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
        className: "min-h-screen bg-background text-foreground",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "container-x py-12",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "eyebrow",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: "inline-block h-1.5 w-1.5 rounded-full bg-primary"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 65,
                                columnNumber: 11
                            }, this),
                            "内部选型预览 · 定稿后删除"
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 64,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                        className: "mt-4 text-3xl font-bold tracking-tight sm:text-4xl",
                        children: "Hero 协作图 · 两版竖图对比"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 68,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mt-3 max-w-3xl text-muted-foreground",
                        children: "同一份「新产品上市调研」协作，两种密度的竖向图，均放在 Hero「左文右图」情境里。 A 主打一眼看懂；B 保留完整机制但已做去蛛网手术。"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 71,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 63,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
                className: "border-t border-border/60 bg-[color-mix(in_oklab,var(--primary),transparent_97%)]",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "container-x py-12",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "mb-6 flex items-baseline gap-3",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "rounded-full bg-primary px-3 py-1 text-sm font-bold text-primary-foreground",
                                    children: "方案A"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 81,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                    className: "text-xl font-semibold",
                                    children: "简化竖图 · 主干叙事（2 秒看懂）"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 84,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 80,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(HeroCopy, {}, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 87,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "w-full lg:justify-self-end",
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "surface mx-auto w-full max-w-[440px] p-5 backdrop-blur-md sm:p-6",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "mb-3 flex items-center justify-between gap-3",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                        className: "eyebrow",
                                                        children: [
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                className: "inline-block h-1.5 w-1.5 rounded-full bg-primary"
                                                            }, void 0, false, {
                                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                                lineNumber: 92,
                                                                columnNumber: 21
                                                            }, this),
                                                            "一次协作 · 概览"
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                        lineNumber: 91,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "shrink-0 text-sm text-muted-foreground",
                                                        children: "6 队员 · 3 波次"
                                                    }, void 0, false, {
                                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                        lineNumber: 95,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 90,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentMapVerticalSimple$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 99,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(WaveLegend, {}, void 0, false, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 100,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 89,
                                        columnNumber: 15
                                    }, this)
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 88,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 86,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                    lineNumber: 79,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 78,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
                className: "border-t border-border/60",
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "container-x py-12",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "mb-6 flex items-baseline gap-3",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    className: "rounded-full bg-primary px-3 py-1 text-sm font-bold text-primary-foreground",
                                    children: "方案B"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 111,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                    className: "text-xl font-semibold",
                                    children: "完整竖图 · 全机制作战图（只留竖图）"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 114,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 110,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "grid items-center gap-12 lg:grid-cols-[0.82fr_1.18fr]",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(HeroCopy, {}, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 119,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "w-full lg:justify-self-end",
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "surface mx-auto w-full max-w-[600px] p-5 backdrop-blur-md sm:p-6",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "mb-3 flex items-center justify-between gap-3",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                        className: "eyebrow",
                                                        children: [
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                className: "inline-block h-1.5 w-1.5 rounded-full bg-primary"
                                                            }, void 0, false, {
                                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                                lineNumber: 124,
                                                                columnNumber: 21
                                                            }, this),
                                                            "一次协作 · 实时作战图"
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                        lineNumber: 123,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "shrink-0 text-sm text-muted-foreground",
                                                        children: "8 队员 · 3 波次"
                                                    }, void 0, false, {
                                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                        lineNumber: 127,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 122,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentWarMapPortrait$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 131,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(WaveLegend, {}, void 0, false, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 132,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 121,
                                        columnNumber: 15
                                    }, this)
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 120,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 118,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                    lineNumber: 109,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 108,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
        lineNumber: 62,
        columnNumber: 5
    }, this);
}
}),
"[project]/apps/website/src/app/preview/maps/page.tsx [app-rsc] (ecmascript, Next.js Server Component)", ((__turbopack_context__) => {

__turbopack_context__.n(__turbopack_context__.i("[project]/apps/website/src/app/preview/maps/page.tsx [app-rsc] (ecmascript)"));
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__027awvz._.js.map