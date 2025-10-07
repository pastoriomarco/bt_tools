import os
import tempfile

from bt_view.bt_view import (
    COLORS_PER_RETURN_STATE,
    draw_pygraphviz,
)

from btlib.bts import fbl_to_networkx
from btlib.common import NODE_STATE

from nav2_msgs.msg import BehaviorTreeLog, BehaviorTreeStatusChange

from rcl_interfaces.msg import ParameterDescriptor

import rclpy
from rclpy.node import Node
from rclpy.time import Time


def _extract_uid(bt_status_change: BehaviorTreeStatusChange):
    """Return a UID-like identifier for a status change event.

    Tries multiple field names for compatibility across Nav2 versions.
    Returns None if no usable identifier is found.
    """
    # direct known field names
    for field in ('uid', 'node_uid', 'node_id'):
        if hasattr(bt_status_change, field):
            try:
                uid = getattr(bt_status_change, field)
                if uid is not None and uid != '':
                    return int(uid) if isinstance(uid, int) else str(uid)
            except Exception:
                pass
    # inspect slots for any *uid* or *id* like field
    for slot in getattr(bt_status_change, '__slots__', []):
        name = slot.lstrip('_')
        if 'uid' in name or (name.endswith('id') and name not in ('status', 'current_status')):
            try:
                uid = getattr(bt_status_change, name)
                if uid is not None and uid != '':
                    return int(uid) if isinstance(uid, int) else str(uid)
            except Exception:
                continue
    return None


def _map_status_to_state(current_status):
    """Map incoming status (int or str) to NODE_STATE enum, if possible."""
    try:
        # numeric; support multiple conventions
        if isinstance(current_status, int):
            # direct match to our enum values (1..4)
            for st in NODE_STATE:
                if st.value == current_status:
                    return st
            # BehaviorTree.CPP common mapping: 0:IDLE,1:RUNNING,2:SUCCESS,3:FAILURE
            mapping = {
                0: NODE_STATE.IDLE,
                1: NODE_STATE.RUNNING,
                2: NODE_STATE.SUCCESS,
                3: NODE_STATE.FAILURE,
            }
            return mapping.get(current_status)
        # string name
        if isinstance(current_status, str):
            name = current_status.strip().upper()
            for st in NODE_STATE:
                if st.name == name:
                    return st
            return None
    except Exception:
        return None
    return None


class SingletonBtLiveNode():
    _instance = None

    def __init__(self, args=None):
        if SingletonBtLiveNode._instance is None:
            SingletonBtLiveNode._instance = BtLiveNode(args=args)

    def __getattr__(self, name):
        return getattr(self._instance, name)

    def __call__(self, *args, **kwargs):
        return self._instance(*args, **kwargs)


class BtLiveNode(Node):

    def __init__(self, args=None):
        rclpy.init(args=args)
        super().__init__('bt_live_node')
        self.get_logger().info('Starting bt_live_node')
        self.data = {}
        self._color_map = {}  # uid(str) -> hex color
        self._default_color = COLORS_PER_RETURN_STATE.get(None, '#cccccc')
        self.sub = self.create_subscription(
            BehaviorTreeLog,
            '/behavior_tree_log',
            self.callback,
            10
        )

        # setting paths
        self.param_fbl_file = self.declare_parameter(
            'fbl_file',
            '',
            ParameterDescriptor(
                description='File to read the BT from.'))
        self.fbl_file = self.param_fbl_file.value
        if self.fbl_file == '':
            raise ValueError('No file specified. Please specify the file to'
                             'read the BT from under the parameter '
                             '`fbl_file`.')
        if not os.path.exists(self.fbl_file):
            raise FileNotFoundError(
                f'File under path fbl_file={self.fbl_file} does not exist.')
        self.img_path = os.path.join(tempfile.gettempdir(), 'bt_trace')
        self.get_logger().info(f'{self.img_path=}')

        self.g = fbl_to_networkx(self.fbl_file)
        # Build name->uid fallback map
        self._uid_by_name = {}
        try:
            for nid in self.g.nodes:
                attrs = self.g.nodes[nid]
                for key in ('name', 'NAME', 'node_name'):
                    if key in attrs:
                        try:
                            name = str(attrs[key])
                            if name:
                                self._uid_by_name[name] = int(nid)
                        except Exception:
                            pass
        except Exception:
            pass

        # initialize color map with default state
        for nid in self.g.nodes:
            self._color_map[str(nid)] = self._default_color

        # make first image with increased spacing to reduce overlap
        draw_pygraphviz(
            self.g,
            self.img_path,
            lambda _: None,
            extra_graph_args='-Gnodesep=1.0 -Granksep=2.4 -Gmargin=0.8',
        )

    def callback(self, msg: BehaviorTreeStatusChange):
        event_log = msg.event_log
        ts = Time().from_msg(msg.timestamp).nanoseconds
        for event in event_log:
            assert isinstance(event, BehaviorTreeStatusChange)
            uid = _extract_uid(event)
            if uid is None and hasattr(event, 'node_name'):
                try:
                    uid = self._uid_by_name.get(str(getattr(event, 'node_name')))
                except Exception:
                    uid = None
            if uid is None:
                # no UID available; skip since coloring maps by node id
                continue
            st = _map_status_to_state(
                getattr(event, 'current_status', getattr(event, 'status', None))
            )
            color = COLORS_PER_RETURN_STATE.get(st, self._default_color)
            self._color_map[str(uid)] = color
        # Expose timestamp and the accumulated color map
        self.data = {'timestamp': ts}
        self.data.update(self._color_map)

    def spin_once(self):
        rclpy.spin_once(self)
        return self.data
