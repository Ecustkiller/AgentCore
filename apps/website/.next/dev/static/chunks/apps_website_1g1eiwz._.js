(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/apps/website/src/components/CollaborationNetwork.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>CollaborationNetwork
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
function CollaborationNetwork() {
    _s();
    const canvasRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "CollaborationNetwork.useEffect": ()=>{
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            // 颜色统一从品牌语义 token 读取，避免在组件内硬编码任何颜色值。
            const styles = getComputedStyle(document.documentElement);
            const colorPrimary = styles.getPropertyValue("--primary").trim();
            const colorBrand2 = styles.getPropertyValue("--brand-2").trim();
            const colorEdge = styles.getPropertyValue("--muted-foreground").trim();
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            let width = 0;
            let height = 0;
            const nodes = [];
            const pulses = [];
            const LINK_DIST = 190;
            const resize = {
                "CollaborationNetwork.useEffect.resize": ()=>{
                    const parent = canvas.parentElement;
                    if (!parent) return;
                    width = parent.clientWidth;
                    height = parent.clientHeight;
                    const dpr = Math.min(window.devicePixelRatio || 1, 2);
                    canvas.width = Math.floor(width * dpr);
                    canvas.height = Math.floor(height * dpr);
                    canvas.style.width = `${width}px`;
                    canvas.style.height = `${height}px`;
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                }
            }["CollaborationNetwork.useEffect.resize"];
            const seed = {
                "CollaborationNetwork.useEffect.seed": ()=>{
                    nodes.length = 0;
                    const count = Math.max(10, Math.min(20, Math.round(width * height / 52000)));
                    for(let i = 0; i < count; i += 1){
                        const hub = i < 2;
                        nodes.push({
                            x: Math.random() * width,
                            y: Math.random() * height,
                            vx: (Math.random() - 0.5) * 0.18,
                            vy: (Math.random() - 0.5) * 0.18,
                            r: hub ? 4.5 : 2 + Math.random() * 1.6,
                            hub
                        });
                    }
                    pulses.length = 0;
                }
            }["CollaborationNetwork.useEffect.seed"];
            const spawnPulse = {
                "CollaborationNetwork.useEffect.spawnPulse": ()=>{
                    if (nodes.length < 2) return;
                    const a = Math.floor(Math.random() * nodes.length);
                    let b = Math.floor(Math.random() * nodes.length);
                    if (b === a) b = (b + 1) % nodes.length;
                    const dx = nodes[a].x - nodes[b].x;
                    const dy = nodes[a].y - nodes[b].y;
                    if (Math.hypot(dx, dy) > LINK_DIST) return;
                    pulses.push({
                        a,
                        b,
                        t: 0,
                        speed: 0.006 + Math.random() * 0.01
                    });
                }
            }["CollaborationNetwork.useEffect.spawnPulse"];
            const draw = {
                "CollaborationNetwork.useEffect.draw": ()=>{
                    ctx.clearRect(0, 0, width, height);
                    // 连线
                    for(let i = 0; i < nodes.length; i += 1){
                        for(let j = i + 1; j < nodes.length; j += 1){
                            const dx = nodes[i].x - nodes[j].x;
                            const dy = nodes[i].y - nodes[j].y;
                            const dist = Math.hypot(dx, dy);
                            if (dist > LINK_DIST) continue;
                            const alpha = (1 - dist / LINK_DIST) * 0.5;
                            ctx.globalAlpha = alpha;
                            ctx.strokeStyle = colorEdge;
                            ctx.lineWidth = 1;
                            ctx.beginPath();
                            ctx.moveTo(nodes[i].x, nodes[i].y);
                            ctx.lineTo(nodes[j].x, nodes[j].y);
                            ctx.stroke();
                        }
                    }
                    // 沿边游走的协作光点
                    for(let p = pulses.length - 1; p >= 0; p -= 1){
                        const pulse = pulses[p];
                        pulse.t += pulse.speed;
                        if (pulse.t >= 1) {
                            pulses.splice(p, 1);
                            continue;
                        }
                        const na = nodes[pulse.a];
                        const nb = nodes[pulse.b];
                        const px = na.x + (nb.x - na.x) * pulse.t;
                        const py = na.y + (nb.y - na.y) * pulse.t;
                        ctx.globalAlpha = Math.sin(pulse.t * Math.PI) * 0.9;
                        ctx.fillStyle = colorBrand2;
                        ctx.beginPath();
                        ctx.arc(px, py, 2.4, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    // 节点
                    for (const n of nodes){
                        if (n.hub) {
                            ctx.globalAlpha = 0.22;
                            ctx.fillStyle = colorPrimary;
                            ctx.beginPath();
                            ctx.arc(n.x, n.y, n.r * 3.2, 0, Math.PI * 2);
                            ctx.fill();
                        }
                        ctx.globalAlpha = n.hub ? 1 : 0.85;
                        ctx.fillStyle = n.hub ? colorPrimary : colorBrand2;
                        ctx.beginPath();
                        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    ctx.globalAlpha = 1;
                }
            }["CollaborationNetwork.useEffect.draw"];
            const step = {
                "CollaborationNetwork.useEffect.step": ()=>{
                    for (const n of nodes){
                        n.x += n.vx;
                        n.y += n.vy;
                        if (n.x < 0 || n.x > width) n.vx *= -1;
                        if (n.y < 0 || n.y > height) n.vy *= -1;
                    }
                    if (Math.random() < 0.04) spawnPulse();
                    draw();
                }
            }["CollaborationNetwork.useEffect.step"];
            let raf = 0;
            const loop = {
                "CollaborationNetwork.useEffect.loop": ()=>{
                    step();
                    raf = requestAnimationFrame(loop);
                }
            }["CollaborationNetwork.useEffect.loop"];
            resize();
            seed();
            if (reduceMotion) {
                draw();
            } else {
                loop();
            }
            const onResize = {
                "CollaborationNetwork.useEffect.onResize": ()=>{
                    resize();
                    seed();
                    if (reduceMotion) draw();
                }
            }["CollaborationNetwork.useEffect.onResize"];
            window.addEventListener("resize", onResize);
            return ({
                "CollaborationNetwork.useEffect": ()=>{
                    cancelAnimationFrame(raf);
                    window.removeEventListener("resize", onResize);
                }
            })["CollaborationNetwork.useEffect"];
        }
    }["CollaborationNetwork.useEffect"], []);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("canvas", {
        ref: canvasRef,
        "aria-hidden": "true",
        className: "pointer-events-none absolute inset-0 h-full w-full"
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/CollaborationNetwork.tsx",
        lineNumber: 189,
        columnNumber: 5
    }, this);
}
_s(CollaborationNetwork, "UJgi7ynoup7eqypjnwyX/s32POg=");
_c = CollaborationNetwork;
var _c;
__turbopack_context__.k.register(_c, "CollaborationNetwork");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/apps/website/src/components/Reveal.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Reveal
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
function Reveal({ children, delay = 0, className = "" }) {
    _s();
    const ref = (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const [visible, setVisible] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Reveal.useEffect": ()=>{
            const el = ref.current;
            if (!el) return;
            const observer = new IntersectionObserver({
                "Reveal.useEffect": (entries)=>{
                    for (const entry of entries){
                        if (entry.isIntersecting) {
                            setVisible(true);
                            observer.disconnect();
                        }
                    }
                }
            }["Reveal.useEffect"], {
                threshold: 0.16,
                rootMargin: "0px 0px -10% 0px"
            });
            observer.observe(el);
            return ({
                "Reveal.useEffect": ()=>observer.disconnect()
            })["Reveal.useEffect"];
        }
    }["Reveal.useEffect"], []);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        ref: ref,
        className: `reveal ${visible ? "is-visible" : ""} ${className}`,
        style: delay ? {
            transitionDelay: `${delay}ms`
        } : undefined,
        children: children
    }, void 0, false, {
        fileName: "[project]/apps/website/src/components/Reveal.tsx",
        lineNumber: 40,
        columnNumber: 5
    }, this);
}
_s(Reveal, "F7BtIAxVh3vOWU1Jr24RYsj9CHc=");
_c = Reveal;
var _c;
__turbopack_context__.k.register(_c, "Reveal");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js [app-client] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
/**
 * @license React
 * react-jsx-dev-runtime.development.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */ "use strict";
"production" !== ("TURBOPACK compile-time value", "development") && function() {
    function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type) return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch(type){
            case REACT_FRAGMENT_TYPE:
                return "Fragment";
            case REACT_PROFILER_TYPE:
                return "Profiler";
            case REACT_STRICT_MODE_TYPE:
                return "StrictMode";
            case REACT_SUSPENSE_TYPE:
                return "Suspense";
            case REACT_SUSPENSE_LIST_TYPE:
                return "SuspenseList";
            case REACT_ACTIVITY_TYPE:
                return "Activity";
            case REACT_VIEW_TRANSITION_TYPE:
                return "ViewTransition";
        }
        if ("object" === typeof type) switch("number" === typeof type.tag && console.error("Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."), type.$$typeof){
            case REACT_PORTAL_TYPE:
                return "Portal";
            case REACT_CONTEXT_TYPE:
                return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
                return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
                var innerType = type.render;
                type = type.displayName;
                type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
                return type;
            case REACT_MEMO_TYPE:
                return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
                innerType = type._payload;
                type = type._init;
                try {
                    return getComponentNameFromType(type(innerType));
                } catch (x) {}
        }
        return null;
    }
    function testStringCoercion(value) {
        return "" + value;
    }
    function checkKeyStringCoercion(value) {
        try {
            testStringCoercion(value);
            var JSCompiler_inline_result = !1;
        } catch (e) {
            JSCompiler_inline_result = !0;
        }
        if (JSCompiler_inline_result) {
            JSCompiler_inline_result = console;
            var JSCompiler_temp_const = JSCompiler_inline_result.error;
            var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
            JSCompiler_temp_const.call(JSCompiler_inline_result, "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.", JSCompiler_inline_result$jscomp$0);
            return testStringCoercion(value);
        }
    }
    function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE) return "<...>";
        try {
            var name = getComponentNameFromType(type);
            return name ? "<" + name + ">" : "<...>";
        } catch (x) {
            return "<...>";
        }
    }
    function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
    }
    function UnknownOwner() {
        return Error("react-stack-top-frame");
    }
    function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
            var getter = Object.getOwnPropertyDescriptor(config, "key").get;
            if (getter && getter.isReactWarning) return !1;
        }
        return void 0 !== config.key;
    }
    function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
            specialPropKeyWarningShown || (specialPropKeyWarningShown = !0, console.error("%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)", displayName));
        }
        warnAboutAccessingKey.isReactWarning = !0;
        Object.defineProperty(props, "key", {
            get: warnAboutAccessingKey,
            configurable: !0
        });
    }
    function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = !0, console.error("Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
    }
    function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
            $$typeof: REACT_ELEMENT_TYPE,
            type: type,
            key: key,
            props: props,
            _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
            enumerable: !1,
            get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", {
            enumerable: !1,
            value: null
        });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: null
        });
        Object.defineProperty(type, "_debugStack", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
            configurable: !1,
            enumerable: !1,
            writable: !0,
            value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
    }
    function jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask) {
        var children = config.children;
        if (void 0 !== children) if (isStaticChildren) if (isArrayImpl(children)) {
            for(isStaticChildren = 0; isStaticChildren < children.length; isStaticChildren++)validateChildKeys(children[isStaticChildren]);
            Object.freeze && Object.freeze(children);
        } else console.error("React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead.");
        else validateChildKeys(children);
        if (hasOwnProperty.call(config, "key")) {
            children = getComponentNameFromType(type);
            var keys = Object.keys(config).filter(function(k) {
                return "key" !== k;
            });
            isStaticChildren = 0 < keys.length ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
            didWarnAboutKeySpread[children + isStaticChildren] || (keys = 0 < keys.length ? "{" + keys.join(": ..., ") + ": ...}" : "{}", console.error('A props object containing a "key" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />', isStaticChildren, children, keys, children), didWarnAboutKeySpread[children + isStaticChildren] = !0);
        }
        children = null;
        void 0 !== maybeKey && (checkKeyStringCoercion(maybeKey), children = "" + maybeKey);
        hasValidKey(config) && (checkKeyStringCoercion(config.key), children = "" + config.key);
        if ("key" in config) {
            maybeKey = {};
            for(var propName in config)"key" !== propName && (maybeKey[propName] = config[propName]);
        } else maybeKey = config;
        children && defineKeyPropWarningGetter(maybeKey, "function" === typeof type ? type.displayName || type.name || "Unknown" : type);
        return ReactElement(type, children, maybeKey, getOwner(), debugStack, debugTask);
    }
    function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
    }
    function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
    }
    var React = __turbopack_context__.r("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)"), REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = Symbol.for("react.memo"), REACT_LAZY_TYPE = Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = Symbol.for("react.view_transition"), REACT_CLIENT_REFERENCE = Symbol.for("react.client.reference"), ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, hasOwnProperty = Object.prototype.hasOwnProperty, isArrayImpl = Array.isArray, createTask = console.createTask ? console.createTask : function() {
        return null;
    };
    React = {
        react_stack_bottom_frame: function(callStackForError) {
            return callStackForError();
        }
    };
    var specialPropKeyWarningShown;
    var didWarnAboutElementRef = {};
    var unknownOwnerDebugStack = React.react_stack_bottom_frame.bind(React, UnknownOwner)();
    var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
    var didWarnAboutKeySpread = {};
    exports.Fragment = REACT_FRAGMENT_TYPE;
    exports.jsxDEV = function(type, config, maybeKey, isStaticChildren) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        if (trackActualOwner) {
            var previousStackTraceLimit = Error.stackTraceLimit;
            Error.stackTraceLimit = 10;
            var debugStackDEV = Error("react-stack-top-frame");
            Error.stackTraceLimit = previousStackTraceLimit;
        } else debugStackDEV = unknownOwnerDebugStack;
        return jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStackDEV, trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask);
    };
}();
}),
"[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)", ((__turbopack_context__, module, exports) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$apps$2f$website$2f$node_modules$2f2e$pnpm$2f$next$40$16$2e$2$2e$9_react$2d$dom$40$19$2e$2$2e$7_react$40$19$2e$2$2e$7_$5f$react$40$19$2e$2$2e$7$2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
'use strict';
if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
;
else {
    module.exports = __turbopack_context__.r("[project]/apps/website/node_modules/.pnpm/next@16.2.9_react-dom@19.2.7_react@19.2.7__react@19.2.7/node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js [app-client] (ecmascript)");
}
}),
]);

//# sourceMappingURL=apps_website_1g1eiwz._.js.map