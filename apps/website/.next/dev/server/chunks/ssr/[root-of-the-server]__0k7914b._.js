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
function AgentWarMapPortrait() {
    const P = "pm";
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
                lineNumber: 30,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SharedWorkspace"], {
                x: 24,
                y: 200,
                w: 632,
                h: 320
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 33,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 40,
                y: 228,
                text: "波次 1 · 并行",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 34,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 40,
                y: 326,
                text: "波次 2 · 依赖",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 35,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 40,
                y: 424,
                text: "波次 3 · 辩论 · 互审",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 36,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M340 72 L340 96"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 39,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M190 128 L255 128"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 40,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M330 160 C 220 195, 150 218, 135 236"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 42,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M340 160 L340 238",
                label: "委派"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 43,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M350 160 C 460 195, 540 218, 545 236"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 44,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M140 282 C 165 305, 195 325, 213 336"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 46,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M335 282 C 300 308, 245 325, 220 336",
                label: "注入"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 47,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M540 282 C 515 305, 478 325, 458 336"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 48,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M210 380 C 180 405, 150 425, 135 432"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 50,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M220 380 C 255 405, 318 425, 338 432"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 51,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M450 380 C 415 405, 358 425, 342 432"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 52,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M460 380 C 490 405, 540 425, 545 432"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 53,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M135 478 C 200 515, 300 548, 332 556"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 55,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M340 478 L340 556",
                label: "综合"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 56,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M545 478 C 480 515, 380 548, 348 556"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 57,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M340 620 L340 660"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 58,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CommEdge"], {
                idPrefix: P,
                d: "M230 456 L245 456"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 61,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CommEdge"], {
                idPrefix: P,
                d: "M435 456 L450 456"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 62,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["EscalationEdge"], {
                idPrefix: P,
                d: "M548 238 C 612 165, 600 58, 392 50"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 65,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: 628,
                y: 150,
                textAnchor: "end",
                fontSize: 10.5,
                fontWeight: 600,
                fill: "var(--warning)",
                children: "escalate 升级"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 66,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M340 72 L340 96",
                dur: 2.2,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 78,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M340 160 L340 238",
                dur: 2.8,
                delay: 0.5,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 79,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M340 478 L340 556",
                dur: 3,
                delay: 1,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 85,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M340 620 L340 660",
                dur: 2.6,
                delay: 1.4,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 91,
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
                lineNumber: 99,
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
                lineNumber: 100,
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
                lineNumber: 101,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 40,
                y: 238,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].market,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 110,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 245,
                y: 238,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].comp,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 111,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 450,
                y: 238,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].interview,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 112,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 120,
                y: 336,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].data,
                wave: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 120,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 360,
                y: 336,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].persona,
                wave: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 121,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 40,
                y: 434,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].pro,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 122,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 245,
                y: 434,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].con,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 123,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 450,
                y: 434,
                w: 190,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].review,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
                lineNumber: 124,
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
                lineNumber: 126,
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
                lineNumber: 134,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx",
        lineNumber: 23,
        columnNumber: 5
    }, this);
}
}),
"[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>AgentWarMapWide
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/shared.tsx [app-rsc] (ecmascript)");
;
;
function AgentWarMapWide() {
    const P = "wm";
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
        viewBox: "0 0 1280 650",
        className: "h-auto w-full",
        role: "img",
        "aria-label": "多 Agent 协作作战地图：你下达目标，CEO 主 Agent 用 delegate 定义 DAG 并组建团队；团队在共享工作区分三波协作——波次1 市场检索/竞品采集/用户访谈并行，波次2 数据分析/用户画像依赖前一波，波次3 方案正反辩论并经评审互审；各 Agent 经 MCP 调用 Web/DB/文件/代码工具，产物经调度器中转；用户访谈遇阻经 escalate 升级给你，CEO 在波边界 replan，最终综合裁决回到你审阅",
        style: {
            fontFamily: "inherit"
        },
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["MapDefs"], {
                idPrefix: P
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 31,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M1179 262 C 1179 22, 70 22, 70 262",
                fill: "none",
                stroke: "var(--brand-2)",
                strokeOpacity: 0.28,
                strokeWidth: 1.3,
                strokeDasharray: "2 7"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 34,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: 625,
                y: 40,
                textAnchor: "middle",
                fontSize: 11.5,
                fontWeight: 600,
                fill: "var(--muted-foreground)",
                children: "你主导 · 全程可见 · 闭环裁决"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 42,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SharedWorkspace"], {
                x: 320,
                y: 70,
                w: 620,
                h: 470
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 54,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 435,
                y: 98,
                text: "波次 1 · 并行"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 55,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 635,
                y: 98,
                text: "波次 2 · 依赖"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 56,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 835,
                y: 98,
                text: "波次 3 · 辩论 · 互审"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 57,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M116 301 L150 301"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 61,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M216 230 L216 265"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 63,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M282 296 C 330 200, 345 140, 360 132"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 65,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M282 301 L360 292",
                label: "委派"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 66,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M282 306 C 330 400, 345 452, 360 452"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 67,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M510 132 C 545 165, 550 195, 560 208"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 69,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M510 292 C 545 255, 550 222, 560 216",
                label: "注入"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 70,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M510 452 C 545 415, 550 385, 560 372"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 71,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M710 212 C 745 180, 750 155, 760 152"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 73,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M710 212 C 745 255, 750 300, 760 306"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 74,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M710 372 C 745 340, 750 318, 760 312"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 75,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M710 372 C 745 415, 750 465, 760 466"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 76,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M910 152 C 945 205, 958 272, 970 286"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 78,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M910 312 L970 304",
                label: "综合"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 79,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M910 472 C 945 420, 958 332, 970 316"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 80,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["FlowEdge"], {
                idPrefix: P,
                d: "M1098 301 L1130 301"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 82,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CommEdge"], {
                idPrefix: P,
                d: "M835 174 L835 290"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 85,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["CommEdge"], {
                idPrefix: P,
                d: "M822 450 C 800 405, 802 362, 820 334"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 86,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 862,
                y: 236,
                text: "辩论",
                anchor: "start"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 87,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["WaveTag"], {
                x: 792,
                y: 398,
                text: "互审",
                anchor: "end"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 88,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["EscalationEdge"], {
                idPrefix: P,
                d: "M356 452 C 240 484, 120 474, 74 340"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 91,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: 206,
                y: 500,
                textAnchor: "middle",
                fontSize: 11,
                fontWeight: 600,
                fill: "var(--warning)",
                children: "escalate · 阻塞升级给你"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 92,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                d: "M630 540 L630 576",
                fill: "none",
                stroke: "var(--muted-foreground)",
                strokeOpacity: 0.4,
                strokeWidth: 1.3,
                strokeDasharray: "3 4"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 104,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("text", {
                x: 360,
                y: 566,
                fontSize: 11,
                fontWeight: 600,
                fill: "var(--muted-foreground)",
                children: "MCP 工具层 · Agent 按需调用"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 112,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ToolChip"], {
                x: 360,
                y: 584,
                w: 118,
                h: 36,
                kind: "web"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 121,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ToolChip"], {
                x: 520,
                y: 584,
                w: 118,
                h: 36,
                kind: "db"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 122,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ToolChip"], {
                x: 680,
                y: 584,
                w: 118,
                h: 36,
                kind: "files"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 123,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ToolChip"], {
                x: 840,
                y: 584,
                w: 118,
                h: 36,
                kind: "code"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 124,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M116 301 L150 301",
                dur: 2.4
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 127,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M282 301 L360 292",
                dur: 2.8,
                delay: 0.4,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 128,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M710 212 C 745 180, 750 155, 760 152",
                dur: 3.2,
                delay: 0.8,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 134,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["TokenDot"], {
                path: "M910 152 C 945 205, 958 272, 970 286",
                dur: 3.4,
                delay: 1.2,
                color: "var(--primary)"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 140,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["YouNode"], {
                x: 24,
                y: 266,
                w: 92,
                h: 70,
                sub: "下达目标"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 148,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 150,
                y: 196,
                w: 132,
                h: 34,
                title: "跨会话记忆"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 149,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 150,
                y: 265,
                w: 132,
                h: 72,
                title: "CEO 主 Agent",
                sub: "delegate · DAG · replan"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 156,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 360,
                y: 110,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].market,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 165,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 360,
                y: 270,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].comp,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 166,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 360,
                y: 430,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].interview,
                wave: 1
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 167,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 560,
                y: 190,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].data,
                wave: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 175,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 560,
                y: 350,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].persona,
                wave: 2
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 176,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 760,
                y: 130,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].pro,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 177,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 760,
                y: 290,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].con,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 178,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AgentChip"], {
                x: 760,
                y: 450,
                w: 150,
                h: 44,
                agent: __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["AGENTS"].review,
                wave: 3
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 179,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["HubNode"], {
                x: 970,
                y: 265,
                w: 128,
                h: 72,
                title: "CEO 综合",
                sub: "裁决 · 汇报"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 181,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$shared$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["YouNode"], {
                x: 1130,
                y: 266,
                w: 98,
                h: 70,
                sub: "审阅 · 决策"
            }, void 0, false, {
                fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
                lineNumber: 189,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx",
        lineNumber: 24,
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
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentWarMapPortrait$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/AgentWarMapPortrait.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentWarMapWide$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/src/components/agentmap/AgentWarMapWide.tsx [app-rsc] (ecmascript)");
;
;
;
const metadata = {
    title: "作战地图选型预览",
    robots: {
        index: false,
        follow: false
    }
};
function Legend() {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "surface mt-6 grid gap-5 p-6 text-sm sm:grid-cols-2 lg:grid-cols-4",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mb-3 font-semibold text-foreground",
                        children: "节点"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 19,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                        className: "space-y-2 text-muted-foreground",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-3 w-3 rounded-sm bg-[var(--primary)]/40 ring-1 ring-[var(--primary)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 22,
                                        columnNumber: 13
                                    }, this),
                                    "你（领导者）· 主色 + 冠标"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 21,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-3 w-3 rounded-sm bg-[var(--card)] ring-1 ring-[var(--primary)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 26,
                                        columnNumber: 13
                                    }, this),
                                    "CEO 编排枢纽"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 25,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-3 w-3 rounded-sm bg-[var(--card)] ring-1 ring-[var(--border)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 30,
                                        columnNumber: 13
                                    }, this),
                                    "队员卡（身份色侧条）"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 29,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 20,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 18,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mb-3 font-semibold text-foreground",
                        children: "状态"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 36,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                        className: "space-y-2 text-muted-foreground",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-2.5 w-2.5 rounded-full bg-[var(--primary)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 39,
                                        columnNumber: 13
                                    }, this),
                                    "运行中（环旋转）"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 38,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-2.5 w-2.5 rounded-full bg-[var(--success)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 43,
                                        columnNumber: 13
                                    }, this),
                                    "已完成（✓）"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 42,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-2.5 w-2.5 rounded-full bg-[var(--warning)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 47,
                                        columnNumber: 13
                                    }, this),
                                    "阻塞（! 闪烁）"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 46,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "flex items-center gap-2",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "inline-block h-2.5 w-2.5 rounded-full bg-[var(--muted-foreground)]"
                                    }, void 0, false, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 51,
                                        columnNumber: 13
                                    }, this),
                                    "待运行（虚线）"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 50,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 37,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 35,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mb-3 font-semibold text-foreground",
                        children: "连线"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 57,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                        className: "space-y-2 text-muted-foreground",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                children: "实线 + 流动短划 · 任务流向（DAG）"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 59,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                children: "双向虚线 + 点 · A2A 协作 / 辩论 / 互审"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 60,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                className: "text-[var(--warning)]",
                                children: "琥珀闪烁虚线 · 阻塞升级给你"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 61,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 58,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 56,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mb-3 font-semibold text-foreground",
                        children: "其它"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 65,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                        className: "space-y-2 text-muted-foreground",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                children: "队员卡右下角印记 · MCP 工具（Web/DB/Files/Code）"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 67,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                children: "虚线圆角框 · 共享工作区"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 68,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                children: "波次标签 · WaveScheduler 调度"
                            }, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 69,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 66,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 64,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
        lineNumber: 17,
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
                                lineNumber: 81,
                                columnNumber: 11
                            }, this),
                            "内部选型预览 · 定稿后删除"
                        ]
                    }, void 0, true, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 80,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                        className: "mt-4 text-3xl font-bold tracking-tight sm:text-4xl",
                        children: "多 Agent 协作作战地图 · 两版对比"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 84,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mt-3 max-w-3xl text-muted-foreground",
                        children: "同一份「新产品上市调研」协作，两种 Hero 落位。注意动效（流动短划、状态环、token 游走、阻塞闪烁）在系统「减弱动效」偏好下会自动停用。"
                    }, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 87,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(Legend, {}, void 0, false, {
                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                        lineNumber: 91,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 79,
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
                                    children: "方案①"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 98,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                    className: "text-xl font-semibold",
                                    children: "加宽右栏 · 竖向地图（左文右图）"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 101,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 97,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "grid items-center gap-10 lg:grid-cols-[0.82fr_1.18fr]",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "max-w-xl",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                            className: "eyebrow",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "inline-block h-1.5 w-1.5 rounded-full bg-primary"
                                                }, void 0, false, {
                                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                    lineNumber: 106,
                                                    columnNumber: 17
                                                }, this),
                                                "协作智能平台"
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 105,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                                            className: "mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "text-gradient",
                                                    children: "协作，"
                                                }, void 0, false, {
                                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                    lineNumber: 110,
                                                    columnNumber: 17
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("br", {}, void 0, false, {
                                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                    lineNumber: 111,
                                                    columnNumber: 17
                                                }, this),
                                                "是更高级的智能"
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 109,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                            className: "mt-6 text-lg leading-relaxed text-muted-foreground",
                                            children: "一句需求，CEO 主 Agent 自动组建团队，按依赖关系分波次推进—— 串行、并行、辩论、互审，全程可见。"
                                        }, void 0, false, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 114,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                            className: "mt-8 flex flex-wrap gap-3",
                                            children: [
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "btn btn-primary",
                                                    children: "下载客户端"
                                                }, void 0, false, {
                                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                    lineNumber: 119,
                                                    columnNumber: 17
                                                }, this),
                                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                    className: "btn btn-ghost",
                                                    children: "看团队如何协作"
                                                }, void 0, false, {
                                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                    lineNumber: 120,
                                                    columnNumber: 17
                                                }, this)
                                            ]
                                        }, void 0, true, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 118,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 104,
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
                                                                lineNumber: 127,
                                                                columnNumber: 21
                                                            }, this),
                                                            "一次协作 · 实时作战图"
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                        lineNumber: 126,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "shrink-0 text-sm text-muted-foreground",
                                                        children: "8 队员 · 3 波次"
                                                    }, void 0, false, {
                                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                        lineNumber: 130,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 125,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentWarMapPortrait$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                                lineNumber: 134,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                        lineNumber: 124,
                                        columnNumber: 15
                                    }, this)
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 123,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 103,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                    lineNumber: 96,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 95,
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
                                    children: "方案②"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 145,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                    className: "text-xl font-semibold",
                                    children: "整宽地图 · 横向系统全景（图为主角）"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 148,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 144,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "mx-auto max-w-3xl text-center",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                                    className: "text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "text-gradient",
                                            children: "协作，"
                                        }, void 0, false, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 152,
                                            columnNumber: 15
                                        }, this),
                                        "是更高级的智能"
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 151,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground",
                                    children: "不是一个助手分饰多角，而是一支真正分工的团队——下面就是一次协作的全景。"
                                }, void 0, false, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 154,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "mt-7 flex flex-wrap justify-center gap-3",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "btn btn-primary",
                                            children: "下载客户端"
                                        }, void 0, false, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 158,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "btn btn-ghost",
                                            children: "看团队如何协作"
                                        }, void 0, false, {
                                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                            lineNumber: 159,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                    lineNumber: 157,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 150,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "surface mt-10 w-full p-5 backdrop-blur-md sm:p-7",
                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$src$2f$components$2f$agentmap$2f$AgentWarMapWide$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                                lineNumber: 163,
                                columnNumber: 13
                            }, this)
                        }, void 0, false, {
                            fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                            lineNumber: 162,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                    lineNumber: 143,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
                lineNumber: 142,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/apps/website/src/app/preview/maps/page.tsx",
        lineNumber: 78,
        columnNumber: 5
    }, this);
}
}),
"[project]/apps/website/src/app/preview/maps/page.tsx [app-rsc] (ecmascript, Next.js Server Component)", ((__turbopack_context__) => {

__turbopack_context__.n(__turbopack_context__.i("[project]/apps/website/src/app/preview/maps/page.tsx [app-rsc] (ecmascript)"));
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0k7914b._.js.map