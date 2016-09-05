import _ from 'lodash';
import d3 from 'd3';
import debug from 'debug';
import React from 'react';
import { connect } from 'react-redux';
import { Map as makeMap, fromJS, is } from 'immutable';
import timely from 'timely';

import { clickBackground } from '../actions/app-actions';
import { EDGE_ID_SEPARATOR } from '../constants/naming';
import { MIN_NODE_SIZE, DETAILS_PANEL_WIDTH, MAX_NODE_SIZE } from '../constants/styles';
import Logo from '../components/logo';
import { doLayout } from './nodes-layout';
import NodesChartElements from './nodes-chart-elements';
import { getActiveTopologyOptions, getAdjacentNodes } from '../utils/topology-utils';

const log = debug('scope:nodes-chart');

const ZOOM_CACHE_FIELDS = ['scale', 'panTranslateX', 'panTranslateY'];

// make sure circular layouts a bit denser with 3-6 nodes
const radiusDensity = d3.scale.threshold()
  .domain([3, 6])
  .range([2.5, 3.5, 3]);


function toNodes(nodes) {
  return nodes.map((node, id) => makeMap({
    id,
    label: node.get('label'),
    pseudo: node.get('pseudo'),
    subLabel: node.get('label_minor'),
    nodeCount: node.get('node_count'),
    metrics: node.get('metrics'),
    rank: node.get('rank'),
    shape: node.get('shape'),
    stack: node.get('stack'),
    networks: node.get('networks'),
  }));
}


function identityPresevingMerge(a, b) {
  //
  // merge two maps, if the values are equal return the old value to preserve (a === a')
  //
  // Note: mergeDeep keeps identity but we can't always use that. E.g. if nodes have been removed in
  // b but still exist in a. they will still exist in the result.
  //
  return a.mergeWith((v1, v2) => is(v1, v2) ? v1 : v2, a, b);
}


function mergeDeepIfExists(mapA, mapB) {
  //
  // Does a deep merge on any key that exists in the first map
  //
  return mapA.map((v, k) => v.mergeDeep(mapB.get(k)));
}


function getLayoutNodes(nodes) {
  return nodes.map(n => makeMap({
    id: n.get('id'),
    adjacency: n.get('adjacency'),
  }));
}


function initEdges(nodes) {
  let edges = makeMap();

  nodes.forEach((node, nodeId) => {
    const adjacency = node.get('adjacency');
    if (adjacency) {
      adjacency.forEach(adjacent => {
        const edge = [nodeId, adjacent];
        const edgeId = edge.join(EDGE_ID_SEPARATOR);

        if (!edges.has(edgeId)) {
          const source = edge[0];
          const target = edge[1];
          if (nodes.has(source) && nodes.has(target)) {
            edges = edges.set(edgeId, makeMap({
              id: edgeId,
              value: 1,
              source,
              target
            }));
          }
        }
      });
    }
  });

  return edges;
}


function getNodeScale(nodes, width, height) {
  const expanse = Math.min(height, width);
  const nodeSize = expanse / 3; // single node should fill a third of the screen
  const maxNodeSize = Math.min(MAX_NODE_SIZE, expanse / 10);
  const normalizedNodeSize = Math.max(MIN_NODE_SIZE,
    Math.min(nodeSize / Math.sqrt(nodes.size), maxNodeSize));

  return d3.scale.linear().range([0, normalizedNodeSize]);
}


function updateLayout({width, height, margins, topologyId, topologyOptions, forceRelayout,
  nodes }) {
  const nodeScale = getNodeScale(nodes, width, height);
  const edges = initEdges(nodes);

  const options = {
    width,
    height,
    margins: margins.toJS(),
    forceRelayout,
    topologyId,
    topologyOptions: topologyOptions.toJS(),
    scale: nodeScale,
  };

  const timedLayouter = timely(doLayout);
  const graph = timedLayouter(nodes, edges, options);

  log(`graph layout took ${timedLayouter.time}ms`);

  // extract coords and save for restore
  const layoutNodes = graph.nodes.map(node => makeMap({
    x: node.get('x'),
    px: node.get('x'),
    y: node.get('y'),
    py: node.get('y')
  }));

  const layoutEdges = graph.edges
    .map(edge => edge.set('ppoints', edge.get('points')));

  return { layoutNodes, layoutEdges, graph, nodeScale };
}

class NodesChart extends React.Component {

  constructor(props, context) {
    super(props, context);

    this.handleMouseClick = this.handleMouseClick.bind(this);
    this.zoomed = this.zoomed.bind(this);

    this.state = {
      edges: makeMap(),
      nodes: makeMap(),
      nodeScale: d3.scale.linear(),
      panTranslateX: 0,
      panTranslateY: 0,
      scale: 1,
      selectedNodeScale: d3.scale.linear(),
      hasZoomed: false,
      height: props.height || 0,
      width: props.width || 0,
      zoomCache: {},

      layoutInput: makeMap(),
      layoutNodes: makeMap(),
    };
  }

  componentWillMount() {
    const state = this.updateGraphState(this.props, this.state);
    this.setState(state);
  }

  componentWillReceiveProps(nextProps) {
    // gather state, setState should be called only once here
    const state = _.assign({}, this.state);

    // wipe node states when showing different topology
    if (nextProps.topologyId !== this.props.topologyId) {
      // re-apply cached canvas zoom/pan to d3 behavior (or set defaul values)
      const defaultZoom = { scale: 1, panTranslateX: 0, panTranslateY: 0, hasZoomed: false };
      const nextZoom = this.state.zoomCache[nextProps.topologyId] || defaultZoom;
      if (nextZoom) {
        this.zoom.scale(nextZoom.scale);
        this.zoom.translate([nextZoom.panTranslateX, nextZoom.panTranslateY]);
      }

      // saving previous zoom state
      const prevZoom = _.pick(this.state, ZOOM_CACHE_FIELDS);
      const zoomCache = _.assign({}, this.state.zoomCache);
      zoomCache[this.props.topologyId] = prevZoom;

      // clear canvas and apply zoom state
      _.assign(state, nextZoom, { zoomCache }, {
        nodes: makeMap(),
        edges: makeMap()
      });
    }

    // reset layout dimensions only when forced
    state.height = nextProps.forceRelayout ? nextProps.height : (state.height || nextProps.height);
    state.width = nextProps.forceRelayout ? nextProps.width : (state.width || nextProps.width);

    _.assign(state, this.updateGraphState(nextProps, state));

    if (this.props.selectedNodeId !== nextProps.selectedNodeId) {
      _.assign(state, this.restoreLayout(state));
    }
    if (nextProps.selectedNodeId) {
      _.assign(state, this.centerSelectedNode(nextProps, state));
    }

    this.setState(state);
  }

  componentDidMount() {
    // distinguish pan/zoom from click
    this.isZooming = false;

    this.zoom = d3.behavior.zoom()
      .scaleExtent([0.1, 2])
      .on('zoom', this.zoomed);

    d3.select('.nodes-chart svg')
      .call(this.zoom);
  }

  componentWillUnmount() {
    // undoing .call(zoom)
    d3.select('.nodes-chart svg')
      .on('mousedown.zoom', null)
      .on('onwheel', null)
      .on('onmousewheel', null)
      .on('dblclick.zoom', null)
      .on('touchstart.zoom', null);
  }

  render() {
    const { edges, nodes, panTranslateX, panTranslateY, scale } = this.state;

    // not passing translates into child components for perf reasons, use getTranslate instead
    const translate = [panTranslateX, panTranslateY];
    const transform = `translate(${translate}) scale(${scale})`;
    const svgClassNames = this.props.isEmpty ? 'hide' : '';

    return (
      <div className="nodes-chart">
        <svg width="100%" height="100%" id="nodes-chart-canvas"
          className={svgClassNames} onClick={this.handleMouseClick}>
          <g transform="translate(24,24) scale(0.25)">
            <Logo />
          </g>
          <NodesChartElements
            layoutNodes={nodes}
            layoutEdges={edges}
            nodeScale={this.state.nodeScale}
            scale={scale}
            transform={transform}
            selectedNodeScale={this.state.selectedNodeScale}
            layoutPrecision={this.props.layoutPrecision} />
        </svg>
      </div>
    );
  }

  handleMouseClick() {
    if (!this.isZooming) {
      this.props.clickBackground();
    } else {
      this.isZooming = false;
    }
  }

  centerSelectedNode(props, state) {
    let stateNodes = state.nodes;
    let stateEdges = state.edges;
    const selectedLayoutNode = stateNodes.get(props.selectedNodeId);

    if (!selectedLayoutNode) {
      return {};
    }

    const adjacentNodes = props.adjacentNodes;
    const adjacentLayoutNodeIds = [];

    adjacentNodes.forEach(adjacentId => {
      // filter loopback
      if (adjacentId !== props.selectedNodeId) {
        adjacentLayoutNodeIds.push(adjacentId);
      }
    });

    // move origin node to center of viewport
    const zoomScale = state.scale;
    const translate = [state.panTranslateX, state.panTranslateY];
    const centerX = (-translate[0] + (state.width + props.margins.left
      - DETAILS_PANEL_WIDTH) / 2) / zoomScale;
    const centerY = (-translate[1] + (state.height + props.margins.top) / 2) / zoomScale;
    stateNodes = stateNodes.mergeIn([props.selectedNodeId], {
      x: centerX,
      y: centerY
    });

    // circle layout for adjacent nodes
    const adjacentCount = adjacentLayoutNodeIds.length;
    const density = radiusDensity(adjacentCount);
    const radius = Math.min(state.width, state.height) / density / zoomScale;
    const offsetAngle = Math.PI / 4;

    stateNodes = stateNodes.map((node) => {
      const index = adjacentLayoutNodeIds.indexOf(node.get('id'));
      if (index > -1) {
        const angle = offsetAngle + Math.PI * 2 * index / adjacentCount;
        return node.merge({
          x: centerX + radius * Math.sin(angle),
          y: centerY + radius * Math.cos(angle)
        });
      }
      return node;
    });

    // fix all edges for circular nodes
    stateEdges = stateEdges.map(edge => {
      if (edge.get('source') === selectedLayoutNode.get('id')
        || edge.get('target') === selectedLayoutNode.get('id')
        || _.includes(adjacentLayoutNodeIds, edge.get('source'))
        || _.includes(adjacentLayoutNodeIds, edge.get('target'))) {
        const source = stateNodes.get(edge.get('source'));
        const target = stateNodes.get(edge.get('target'));
        return edge.set('points', fromJS([
          {x: source.get('x'), y: source.get('y')},
          {x: target.get('x'), y: target.get('y')}
        ]));
      }
      return edge;
    });

    // auto-scale node size for selected nodes
    const selectedNodeScale = getNodeScale(adjacentNodes, state.width, state.height);

    return {
      selectedNodeScale,
      edges: stateEdges,
      nodes: stateNodes
    };
  }

  restoreLayout(state) {
    // undo any pan/zooming that might have happened
    this.zoom.scale(state.scale);
    this.zoom.translate([state.panTranslateX, state.panTranslateY]);

    const nodes = state.nodes.map(node => node.merge({
      x: node.get('px'),
      y: node.get('py')
    }));

    const edges = state.edges.map(edge => {
      if (edge.has('ppoints')) {
        return edge.set('points', edge.get('ppoints'));
      }
      return edge;
    });

    return { edges, nodes };
  }

  updateGraphState(props, state) {
    if (props.nodes.size === 0) {
      return {
        nodes: makeMap(),
        edges: makeMap()
      };
    }

    const nextState = { nodes: toNodes(props.nodes) };

    //
    // pull this out into redux.
    //
    const layoutInput = identityPresevingMerge(state.layoutInput, {
      width: state.width,
      height: state.height,
      nodes: getLayoutNodes(props.nodes),
      margins: fromJS(props.margins),
      topologyId: props.topologyId,
      topologyOptions: fromJS(props.topologyOptions),
      forceRelayout: props.forceRelayout,
    });

    // layout input hasn't changed.
    // TODO: move this out into reselect
    if (state.layoutInput !== layoutInput) {
      nextState.layoutInput = layoutInput;

      const { layoutNodes, layoutEdges, graph, nodeScale } = updateLayout(layoutInput.toObject());
      //
      // adjust layout based on viewport
      const xFactor = (state.width - props.margins.left - props.margins.right) / graph.width;
      const yFactor = state.height / graph.height;
      const zoomFactor = Math.min(xFactor, yFactor);
      let zoomScale = state.scale;

      if (this.zoom && !state.hasZoomed && zoomFactor > 0 && zoomFactor < 1) {
        zoomScale = zoomFactor;
        // saving in d3's behavior cache
        this.zoom.scale(zoomFactor);
      }

      nextState.scale = zoomScale;
      nextState.edges = layoutEdges;
      nextState.nodeScale = nodeScale;
      nextState.layoutNodes = layoutNodes;
    }

    nextState.nodes = mergeDeepIfExists(nextState.nodes,
      (nextState.layoutNodes || state.layoutNodes));

    return nextState;
  }

  zoomed() {
    // debug('zoomed', d3.event.scale, d3.event.translate);
    this.isZooming = true;
    // dont pan while node is selected
    if (!this.props.selectedNodeId) {
      this.setState({
        hasZoomed: true,
        panTranslateX: d3.event.translate[0],
        panTranslateY: d3.event.translate[1],
        scale: d3.event.scale
      });
    }
  }
}

function mapStateToProps(state) {
  return {
    adjacentNodes: getAdjacentNodes(state),
    forceRelayout: state.get('forceRelayout'),
    selectedNodeId: state.get('selectedNodeId'),
    topologyId: state.get('currentTopologyId'),
    topologyOptions: getActiveTopologyOptions(state)
  };
}

export default connect(
  mapStateToProps,
  { clickBackground }
)(NodesChart);
