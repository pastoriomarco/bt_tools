import json
import os
import random

from bt_live.ros_node import SingletonBtLiveNode
from bt_view.bt_view import NODE_HEIGHT_IN, NODE_WIDTH_IN, draw_pygraphviz

from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.http import JsonResponse
import json as _json


def index(request):
    node = SingletonBtLiveNode()
    img_path = node.img_path

    fname_svg = img_path + '.svg'
    with open(fname_svg, 'r') as f:
        svg_str = f.read()
    assert len(svg_str)

    fname_js = os.path.join(
        os.path.dirname(__file__),
        '..',
        'bt_live_django',
        'view.js'
    )
    with open(fname_js, 'r') as f:
        js_str = f.read()
    assert len(js_str)

    index_page_str = (
        """
        <!DOCTYPE html>
        <html>
        <head>
        <title>bt_live</title>
        <!-- favicon -->
        <link rel=icon href=favicon.png sizes=32x32 type=image/png>
        <link rel=icon href=favicon.svg sizes=any type=image/svg+xml>
        <!-- jquery -->
        <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.6.4/jquery.min.js"></script>
        <!-- w3 stylesheet -->
        <link rel="stylesheet" href="https://www.w3schools.com/w3css/4/w3.css">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Lato">
        <link
            rel="stylesheet"
            href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css"
        >
        <!-- pan and zoom -->
        <script src='https://unpkg.com/panzoom@9.4.0/dist/panzoom.min.js'></script>
        </head>
        <body>

        <!-- Navbar -->
        <div class="w3-top">
            <div class="w3-bar w3-black w3-card">
                <li class="w3-bar-item w3-padding-large w3-large">bt_live</li>
                <li class="w3-bar-item w3-padding-large w3-right" id="last_update">..</li>
            </div>
        </div>
        <br><br><br>
        """
        +
        f'{svg_str}'
        +
        """
        <script>
        """
        +
        f'{js_str}'
        +
        """
        </script>
        </body>
        </html>
        """)
    return HttpResponse(index_page_str)


@csrf_exempt
def relayout(request):
    """Re-render the SVG with node widths/heights provided by the client.

    Body JSON format:
    {
      "dims": { "<node_id>": {"w": <inches>, "h": <inches>}, ... }
    }
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        payload = _json.loads(request.body.decode('utf-8') or '{}')
    except Exception:
        payload = {}
    dims = payload.get('dims', {}) or {}

    node = SingletonBtLiveNode()
    img_path = node.img_path

    g = node.g

    def modifier(n):
        try:
            nid = int(str(n))
        except Exception:
            return
        if str(nid) in dims:
            wh = dims[str(nid)]
            w = wh.get('w')
            h = wh.get('h')
            if w:
                n.attr['width'] = str(float(w))
            if h:
                n.attr['height'] = str(float(h))

    # derive graph spacing based on requested sizes
    try:
        max_w = max([float(d.get('w', NODE_WIDTH_IN)) for d in dims.values()]) if dims else NODE_WIDTH_IN
        max_h = max([float(d.get('h', NODE_HEIGHT_IN)) for d in dims.values()]) if dims else NODE_HEIGHT_IN
    except Exception:
        max_w, max_h = NODE_WIDTH_IN, NODE_HEIGHT_IN
    # base sep values in inches
    base_nodesep = 1.0
    base_ranksep = 2.4
    # scale by relative size increase (bounded)
    nodesep = max(base_nodesep, min(3.0, base_nodesep * (max_w / NODE_WIDTH_IN)))
    ranksep = max(base_ranksep, min(5.5, base_ranksep * (max_h / NODE_HEIGHT_IN)))
    margin = max(0.8, 0.25 * max(max_w, max_h))
    extra = f"-Gnodesep={nodesep} -Granksep={ranksep} -Gmargin={margin}"

    draw_pygraphviz(g, img_path, modifier, extra_graph_args=extra)

    # Return the fresh SVG string
    fname_svg = img_path + '.svg'
    with open(fname_svg, 'r') as f:
        svg_str = f.read()
    return HttpResponse(svg_str, content_type='image/svg+xml')


def data(request):
    states = {i: random.randint(1, 4) for i in range(100)}
    return HttpResponse(
        json.dumps(states)
    )


def favicon_png(request):
    with open(os.path.join(
        # get_package_share_directory(''), TODO
        'doc',
        'logo32p.png'
    ), 'rb') as f:
        return HttpResponse(f.read(), content_type='image/png')


def favicon_svg(request):
    with open(os.path.join(
        # get_package_share_directory(''), TODO
        'doc',
        'logo.svg'
    ), 'rb') as f:
        return HttpResponse(f.read(), content_type='image/svg+xml')
