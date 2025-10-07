const BtLive = (() => {
    const TIMEOUT_MS = 5000;
    const DEFAULT_FILL = '#eeeeee';
    const STORAGE_KEY = 'bt_collapsed_nodes';
    const PT_PER_IN = 72.0;

    const state = {
        connected: false,
        heartbeat: null,
        xhr: null,
        svg: null,
        nodeElems: new Map(),          // id -> <g class="node">
        edgeElems: [],                 // {u, v, elem}
        children: new Map(),           // id -> Set(childId)
        parents: new Map(),            // id -> Set(parentId)
        collapsed: new Set(),          // collapsed node ids
        collapsedDims: new Map(),      // id -> {w, h} (inches)
        colors: new Map(),             // id -> color string
        lastTimestamp: null,
        relayoutTimer: null,
        handlersInstalled: false,
    };

    function init() {
        state.svg = document.querySelector('svg');
        if (!state.svg) {
            console.error('[bt_live] Unable to locate SVG root.');
            return;
        }

        attachPanzoom();
        rebuildIndex();
        loadCollapsedFromStorage();
        restoreCollapsedOverlays();
        applyVisibility();
        updatePolygonColors();
        installHandlers();
        connect();
    }

    function attachPanzoom() {
        try {
            panzoom(state.svg, { bounds: true, boundsPadding: 0.1 });
        } catch (err) {
            console.warn('[bt_live] panzoom unavailable', err);
        }
    }

    function installHandlers() {
        if (state.handlersInstalled) {
            return;
        }

        document.addEventListener('click', onDocumentClick, true);
        window.addEventListener('resize', () => scheduleVisibilityRefresh());
        state.handlersInstalled = true;
    }

    function onDocumentClick(ev) {
        if (!state.svg) return;
        const nodeGroup = ev.target.closest('g.node');
        if (!nodeGroup || !state.svg.contains(nodeGroup)) {
            return;
        }
        const nodeId = nodeGroup.id || null;
        if (!nodeId) {
            return;
        }

        const targetDataId = ev.target.getAttribute && ev.target.getAttribute('data-node-id');
        const toggleId = targetDataId ? String(targetDataId) : nodeId;

        toggleCollapse(toggleId);
        ev.stopPropagation();
    }

    function connect() {
        if (state.connected) {
            return;
        }
        if (state.xhr) {
            try {
                state.xhr.abort();
            } catch (err) {
                console.debug('[bt_live] abort previous xhr failed', err);
            }
        }

        const xhr = new XMLHttpRequest();
        state.xhr = xhr;
        xhr.open('GET', 'msg');
        xhr.onreadystatechange = () => {
            if (xhr.readyState === XMLHttpRequest.DONE && xhr.status !== 200) {
                handleDisconnect();
            }
        };
        xhr.onprogress = () => {
            resetHeartbeat();
            const payload = parseSseBuffer(xhr.responseText);
            if (!payload) {
                return;
            }
            handleStreamUpdate(payload);
            state.connected = true;
            setStatusLabel('Last update: ' + new Date().toLocaleTimeString());
        };
        xhr.onerror = handleDisconnect;
        xhr.send();
        resetHeartbeat();
    }

    function parseSseBuffer(buffer) {
        if (!buffer) {
            return null;
        }
        const idx = buffer.lastIndexOf('{');
        if (idx === -1) {
            return null;
        }
        try {
            return JSON.parse(buffer.slice(idx));
        } catch (err) {
            console.warn('[bt_live] Failed to parse stream payload', err);
            return null;
        }
    }

    function resetHeartbeat() {
        if (state.heartbeat) {
            clearTimeout(state.heartbeat);
        }
        state.heartbeat = setTimeout(handleDisconnect, TIMEOUT_MS);
    }

    function handleDisconnect() {
        if (state.connected) {
            console.warn('[bt_live] Disconnected from bt_live stream');
        }
        state.connected = false;
        if (state.heartbeat) {
            clearTimeout(state.heartbeat);
            state.heartbeat = null;
        }
        setStatusLabel('Disconnected – retrying...');
        setTimeout(connect, 1500);
    }

    function handleStreamUpdate(payload) {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        if (payload.timestamp !== undefined) {
            state.lastTimestamp = payload.timestamp;
        }

        Object.keys(payload).forEach((key) => {
            if (key === 'timestamp') {
                return;
            }
            const color = payload[key];
            if (typeof color === 'string' && color.startsWith('#')) {
                state.colors.set(String(key), color);
            }
        });

        updatePolygonColors();
        applyColorsToCollapsed();
    }

    function setStatusLabel(text) {
        const label = document.getElementById('last_update');
        if (label) {
            label.textContent = text;
        }
    }

    function rebuildIndex() {
        state.nodeElems.clear();
        state.children.clear();
        state.parents.clear();
        state.edgeElems = [];

        state.svg.querySelectorAll('g.node').forEach((nodeGroup) => {
            if (!nodeGroup.id) {
                return;
            }
            state.nodeElems.set(nodeGroup.id, nodeGroup);
            const polygon = nodeGroup.querySelector('polygon');
            const initialFill = polygon ? polygon.getAttribute('fill') : null;
            if (!state.colors.has(nodeGroup.id)) {
                state.colors.set(nodeGroup.id, initialFill || DEFAULT_FILL);
            }
        });

        state.svg.querySelectorAll('g.edge').forEach((edgeGroup) => {
            const title = edgeGroup.querySelector('title');
            if (!title) {
                return;
            }
            const txt = title.textContent.trim();
            if (!txt.includes('->')) {
                return;
            }
            const [rawU, rawV] = txt.split('->');
            const u = rawU.trim();
            const v = rawV.trim();
            state.edgeElems.push({ u, v, elem: edgeGroup });
            if (!state.children.has(u)) {
                state.children.set(u, new Set());
            }
            state.children.get(u).add(v);
            if (!state.parents.has(v)) {
                state.parents.set(v, new Set());
            }
            state.parents.get(v).add(u);
        });
    }

    function loadCollapsedFromStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return;
            }
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                state.collapsed = new Set(arr.map(String));
            }
        } catch (err) {
            console.warn('[bt_live] Failed to read collapsed nodes from storage', err);
        }
    }

    function persistCollapsed() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(state.collapsed)));
        } catch (err) {
            console.warn('[bt_live] Failed to persist collapsed nodes', err);
        }
    }

    function restoreCollapsedOverlays() {
        state.collapsedDims.clear();
        state.collapsed.forEach((id) => ensureCollapsedVisual(id));
    }

    function toggleCollapse(nodeId) {
        const id = String(nodeId);
        const childSet = state.children.get(id);
        if (!childSet || childSet.size === 0) {
            return; // leaf nodes cannot be collapsed
        }

        if (state.collapsed.has(id)) {
            state.collapsed.delete(id);
            removeCollapsedVisual(id);
        } else {
            state.collapsed.add(id);
            ensureCollapsedVisual(id);
        }

        applyVisibility();
        persistCollapsed();
        scheduleRelayout();
    }

    function applyVisibility() {
        state.nodeElems.forEach((nodeGroup, id) => {
            const hidden = hasCollapsedAncestor(id);
            nodeGroup.style.display = hidden ? 'none' : '';
            const overlay = nodeGroup.querySelector('g.collapsed-subtree');
            if (overlay) {
                overlay.style.display = state.collapsed.has(id) && !hidden ? '' : 'none';
            }
        });

        state.edgeElems.forEach(({ u, v, elem }) => {
            const showU = !hasCollapsedAncestor(u) && !state.collapsed.has(u);
            const showV = !hasCollapsedAncestor(v);
            elem.style.display = (showU && showV) ? '' : 'none';
        });
    }

    function hasCollapsedAncestor(nodeId) {
        const visited = new Set();
        const stack = [];
        const parents = state.parents.get(nodeId);
        if (parents) {
            parents.forEach((p) => stack.push(p));
        }
        while (stack.length) {
            const candidate = stack.pop();
            if (!candidate || visited.has(candidate)) {
                continue;
            }
            visited.add(candidate);
            if (state.collapsed.has(candidate)) {
                return true;
            }
            const uppers = state.parents.get(candidate);
            if (uppers) {
                uppers.forEach((p) => stack.push(p));
            }
        }
        return false;
    }

    function getColor(nodeId) {
        const key = String(nodeId);
        if (state.colors.has(key)) {
            const color = state.colors.get(key);
            return color || DEFAULT_FILL;
        }
        const nodeGroup = state.nodeElems.get(key);
        if (nodeGroup) {
            const polygon = nodeGroup.querySelector('polygon');
            if (polygon) {
                const fill = polygon.getAttribute('fill');
                state.colors.set(key, fill || DEFAULT_FILL);
                return fill || DEFAULT_FILL;
            }
        }
        state.colors.set(key, DEFAULT_FILL);
        return DEFAULT_FILL;
    }

    function updatePolygonColors() {
        state.nodeElems.forEach((nodeGroup, id) => {
            const polygon = nodeGroup.querySelector('polygon');
            if (!polygon) {
                return;
            }
            const color = getColor(id);
            polygon.setAttribute('fill', color);
        });
    }

    function applyColorsToCollapsed() {
        state.svg.querySelectorAll('g.collapsed-subtree rect[data-node-id]').forEach((rect) => {
            const nodeId = rect.getAttribute('data-node-id');
            if (!nodeId) return;
            const color = getColor(nodeId);
            rect.setAttribute('fill', color);
            rect.setAttribute('stroke', '#555');
            rect.setAttribute('stroke-width', '0.6');
        });
    }

    function ensureCollapsedVisual(nodeId) {
        const id = String(nodeId);
        const nodeGroup = state.nodeElems.get(id);
        if (!nodeGroup) {
            return;
        }
        const polygon = nodeGroup.querySelector('polygon');
        if (!polygon) {
            return;
        }

        if (!nodeGroup.dataset.origPoints) {
            nodeGroup.dataset.origPoints = polygon.getAttribute('points') || '';
        }

        hideNativeLabel(nodeGroup);
        removeClipPaths(nodeGroup);

        const tree = buildSubtree(id);
        if (!tree.length) {
            return; // nothing to collapse
        }

        const box = bboxOfPoints(polygon.getAttribute('points'));
        const paddingX = 6;
        const topPad = 6;
        const bottomPad = 8;
        const rowH = 18;
        const rowGap = 4;
        const indent = 12;
        const innerPadBottom = 6;

        const innerWidthCurrent = box.width - 2 * paddingX;
        const requiredWidth = requiredInnerWidth(tree, indent, getNodeLabelText(id));
        const innerWidth = Math.max(innerWidthCurrent, Math.ceil(requiredWidth));
        const totalWidth = innerWidth + 2 * paddingX;

        const hInfo = computeHeights(tree, rowH, rowGap, innerPadBottom);
        const headerH = rowH;
        const contentH = headerH + rowGap + hInfo.total;
        const neededH = topPad + contentH + bottomPad;
        const newHeight = Math.max(box.height, neededH);

        const newMinX = box.minX;
        const newMinY = box.minY;
        const newMaxX = box.minX + totalWidth;
        const newMaxY = box.minY + newHeight;

        polygon.setAttribute('points', rectPoints(newMinX, newMinY, newMaxX, newMaxY));
        state.collapsedDims.set(id, {
            w: totalWidth / PT_PER_IN,
            h: newHeight / PT_PER_IN,
        });

        let overlay = nodeGroup.querySelector('g.collapsed-subtree');
        if (!overlay) {
            overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            overlay.setAttribute('class', 'collapsed-subtree');
            nodeGroup.appendChild(overlay);
        }
        overlay.innerHTML = '';
        overlay.setAttribute('transform', `translate(${box.minX + paddingX}, ${box.minY + topPad})`);

        ensureSvgCanvasBounds(newMinY - 8, newMaxY + 8);

        // Header background
        const headerBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        headerBg.setAttribute('x', '0');
        headerBg.setAttribute('y', '0');
        headerBg.setAttribute('width', String(innerWidth));
        headerBg.setAttribute('height', String(rowH));
        headerBg.setAttribute('rx', '2');
        headerBg.setAttribute('ry', '2');
        headerBg.setAttribute('fill', getColor(id));
        headerBg.setAttribute('stroke', '#555');
        headerBg.setAttribute('stroke-width', '0.6');
        headerBg.setAttribute('data-node-id', id);
        overlay.appendChild(headerBg);

        const headerText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        headerText.setAttribute('x', '4');
        headerText.setAttribute('y', String(rowH - 5));
        headerText.setAttribute('fill', '#111');
        headerText.setAttribute('font-size', '10px');
        headerText.setAttribute('font-family', 'Bitstream Vera Sans Mono, monospace');
        headerText.textContent = getNodeLabelText(id);
        overlay.appendChild(headerText);

        let cursorY = rowH + rowGap;
        tree.forEach((node, idx) => {
            cursorY = drawCollapsedNode(node, 0, cursorY, overlay, innerWidth, rowH, rowGap, indent, hInfo);
            if (idx < tree.length - 1) {
                cursorY += rowGap;
            }
        });

        applyColorsToCollapsed();
    }

    function hideNativeLabel(nodeGroup) {
        Array.from(nodeGroup.children).forEach((child) => {
            if (child.tagName === 'polygon' || child.classList.contains('collapsed-subtree')) {
                return;
            }
            if (!child.dataset.origDisplay) {
                child.dataset.origDisplay = child.style.display || '';
            }
            child.style.display = 'none';
        });
    }

    function restoreNativeLabel(nodeGroup) {
        Array.from(nodeGroup.children).forEach((child) => {
            if (child.tagName === 'polygon' || child.classList.contains('collapsed-subtree')) {
                return;
            }
            if (child.dataset.origDisplay !== undefined) {
                child.style.display = child.dataset.origDisplay;
                delete child.dataset.origDisplay;
            } else {
                child.style.display = '';
            }
        });
    }

    function removeClipPaths(nodeGroup) {
        nodeGroup.removeAttribute('clip-path');
        nodeGroup.querySelectorAll('[clip-path]').forEach((elem) => elem.removeAttribute('clip-path'));
        nodeGroup.style.overflow = 'visible';
    }

    function drawCollapsedNode(node, depth, startY, overlay, innerWidth, rowH, rowGap, indent, hInfo) {
        const x = depth * indent;
        const nodeHeight = hInfo.heights[node.id];
        const width = Math.max(10, innerWidth - x - 2);

        const container = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        container.setAttribute('x', String(x));
        container.setAttribute('y', String(startY));
        container.setAttribute('width', String(width));
        container.setAttribute('height', String(nodeHeight));
        container.setAttribute('rx', '2');
        container.setAttribute('ry', '2');
        container.setAttribute('fill', '#ffffff');
        container.setAttribute('stroke', '#999');
        container.setAttribute('stroke-width', '0.6');
        overlay.appendChild(container);

        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelBg.setAttribute('x', String(x));
        labelBg.setAttribute('y', String(startY));
        labelBg.setAttribute('width', String(width));
        labelBg.setAttribute('height', String(rowH));
        labelBg.setAttribute('rx', '2');
        labelBg.setAttribute('ry', '2');
        labelBg.setAttribute('data-node-id', String(node.id));
        overlay.appendChild(labelBg);

        const labelText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        labelText.setAttribute('x', String(x + 4));
        labelText.setAttribute('y', String(startY + rowH - 5));
        labelText.setAttribute('fill', '#111');
        labelText.setAttribute('font-size', '10px');
        labelText.setAttribute('font-family', 'Bitstream Vera Sans Mono, monospace');
        labelText.textContent = getNodeLabelText(node.id);
        overlay.appendChild(labelText);

        let cursorY = startY + rowH;
        if (node.children && node.children.length) {
            node.children.forEach((child, idx) => {
                cursorY = drawCollapsedNode(child, depth + 1, cursorY, overlay, innerWidth, rowH, rowGap, indent, hInfo);
                if (idx < node.children.length - 1) {
                    cursorY += rowGap;
                }
            });
        }

        return startY + nodeHeight;
    }

    function removeCollapsedVisual(nodeId) {
        const id = String(nodeId);
        const nodeGroup = state.nodeElems.get(id);
        if (!nodeGroup) {
            return;
        }
        const polygon = nodeGroup.querySelector('polygon');
        if (polygon && nodeGroup.dataset.origPoints) {
            polygon.setAttribute('points', nodeGroup.dataset.origPoints);
        }
        const overlay = nodeGroup.querySelector('g.collapsed-subtree');
        if (overlay) {
            overlay.remove();
        }
        restoreNativeLabel(nodeGroup);
        state.collapsedDims.delete(id);
    }

    function scheduleRelayout() {
        if (state.relayoutTimer) {
            clearTimeout(state.relayoutTimer);
        }
        state.relayoutTimer = setTimeout(postRelayout, 120);
    }

    function postRelayout() {
        const dimsPayload = {};
        state.collapsedDims.forEach((value, key) => {
            dimsPayload[key] = value;
        });

        fetch('relayout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dims: dimsPayload }),
        })
            .then((resp) => resp.text())
            .then((svgText) => replaceSvg(svgText))
            .catch((err) => console.error('[bt_live] relayout failed', err));
    }

    function replaceSvg(svgMarkup) {
        if (!svgMarkup) {
            return;
        }
        const container = document.createElement('div');
        container.innerHTML = svgMarkup.trim();
        const newSvg = container.querySelector('svg');
        if (!newSvg) {
            console.warn('[bt_live] relayout returned no SVG');
            return;
        }

        if (state.svg && state.svg.parentNode) {
            state.svg.parentNode.replaceChild(newSvg, state.svg);
        }
        state.svg = newSvg;

        attachPanzoom();
        rebuildIndex();
        restoreCollapsedOverlays();
        applyVisibility();
        updatePolygonColors();
        applyColorsToCollapsed();
    }

    function scheduleVisibilityRefresh() {
        requestAnimationFrame(() => applyVisibility());
    }

    function ensureSvgCanvasBounds(minY, maxY) {
        if (!state.svg) {
            return;
        }
        const vbAttr = state.svg.getAttribute('viewBox');
        if (!vbAttr) {
            return;
        }
        const vbParts = vbAttr.trim().split(/\s+/).map(Number);
        if (vbParts.length !== 4 || vbParts.some((n) => Number.isNaN(n))) {
            return;
        }
        let [x, y, width, height] = vbParts;
        let top = y;
        let bottom = y + height;
        const margin = 20;
        let updated = false;

        if (minY - margin < top) {
            const newTop = minY - margin;
            const delta = top - newTop;
            y = newTop;
            height += delta;
            top = newTop;
            updated = true;
        }
        if (maxY + margin > bottom) {
            bottom = maxY + margin;
            height = bottom - y;
            updated = true;
        }

        if (updated) {
            state.svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
            const currentHeight = parseFloat(state.svg.getAttribute('height'));
            if (!Number.isNaN(currentHeight) && currentHeight < height) {
                state.svg.setAttribute('height', String(height));
            }
        }
    }

    function buildSubtree(rootId) {
        const makeNode = (id) => {
            const kids = state.children.get(id);
            return {
                id,
                children: kids ? Array.from(kids).map((childId) => makeNode(childId)) : [],
            };
        };

        const directChildren = state.children.get(rootId);
        if (!directChildren) {
            return [];
        }
        return Array.from(directChildren).map((childId) => makeNode(childId));
    }

    function computeHeights(nodes, rowH, rowGap, innerPadBottom) {
        const heights = {};
        const calc = (node) => {
            if (!node.children || node.children.length === 0) {
                heights[node.id] = rowH;
                return rowH;
            }
            let sum = 0;
            node.children.forEach((child, idx) => {
                sum += calc(child);
                if (idx < node.children.length - 1) {
                    sum += rowGap;
                }
            });
            heights[node.id] = rowH + sum + innerPadBottom;
            return heights[node.id];
        };

        let total = 0;
        nodes.forEach((n, idx) => {
            total += calc(n);
            if (idx < nodes.length - 1) {
                total += rowGap;
            }
        });
        return { heights, total };
    }

    function requiredInnerWidth(tree, indent, headerText) {
        const labelPadLeft = 4;
        const labelPadRight = 8;

        const calcNode = (node, depth) => {
            const labelWidth = measureTextWidth(getNodeLabelText(node.id));
            const selfWidth = depth * indent + labelPadLeft + labelWidth + labelPadRight;
            let childWidth = 0;
            if (node.children && node.children.length) {
                node.children.forEach((child) => {
                    childWidth = Math.max(childWidth, calcNode(child, depth + 1));
                });
            }
            return Math.max(selfWidth, childWidth);
        };

        let width = labelPadLeft + measureTextWidth(headerText || '') + labelPadRight;
        tree.forEach((node) => {
            width = Math.max(width, calcNode(node, 0));
        });
        return width;
    }

    function measureTextWidth(text) {
        const temp = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        temp.setAttribute('x', '-10000');
        temp.setAttribute('y', '-10000');
        temp.setAttribute('visibility', 'hidden');
        temp.setAttribute('font-size', '10px');
        temp.setAttribute('font-family', 'Bitstream Vera Sans Mono, monospace');
        temp.textContent = text || '';
        state.svg.appendChild(temp);
        let width = 0;
        try {
            width = temp.getBBox().width;
        } catch (err) {
            width = (text ? text.length : 1) * 6;
        }
        state.svg.removeChild(temp);
        return width;
    }

    function bboxOfPoints(points) {
        const coords = points.split(/\s+/).filter(Boolean).map((pair) => pair.split(',').map(parseFloat));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        coords.forEach(([x, y]) => {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        });
        return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
    }

    function rectPoints(minX, minY, maxX, maxY) {
        return `${minX},${minY} ${maxX},${minY} ${maxX},${maxY} ${minX},${maxY}`;
    }

    function getNodeLabelText(id) {
        const nodeGroup = state.nodeElems.get(String(id));
        if (!nodeGroup) {
            return String(id);
        }
        const text = nodeGroup.querySelector('text');
        if (!text || !text.textContent) {
            return String(id);
        }
        return text.textContent.trim() || String(id);
    }

    return { init };
})();

document.addEventListener('DOMContentLoaded', () => BtLive.init());
