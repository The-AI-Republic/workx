# DOM Serialization Debug Report

## Summary
While testing the DOM tool against `https://x.com/home`, the serialization pipeline returned a snapshot containing only the `#document` node. Inspection shows the `PaintOrderFilter` stage is deleting almost every element before serialization, leaving no interactive nodes for the LLM.

## Key Findings
- The recorded virtual DOM (`.debug/x_com_virtual_node.json`) contains 3,323 nodes, including 937 semantic and 144 non-semantic entries, so the snapshot capture is healthy.
- Replaying the pipeline logic identified that `PaintOrderFilter` is responsible for collapsing the tree. Its global occlusion pass treats descendants as occluding their ancestors. Containers such as `<html>` and `<body>` have low paint orders (`1`), so after higher-order descendants are processed the union fully covers the containers' bounding boxes. They are then marked occluded and removed. (See `src/tools/dom/serializers/filters/PaintOrderFilter.ts:111-150`).
- A quick reproduction script against the saved snapshot showed 2,144 nodes marked as occluded, including `<html>` (backendNodeId `37`) and `<body>` (`96`). Over 1,500 of the occluded entries still have children, proving the filter is removing entire subtrees instead of just hidden leaves. Once `<body>` is removed the serialization step only sees the root document node, matching the runtime failure.

## Proposed Changes
1. Make `PaintOrderFilter` DOM-aware before pruning:
   - Run occlusion detection per parent (siblings only) instead of a single flat union. A union that ignores ancestry should not be allowed to remove a node if the covering rectangles come exclusively from the node's own descendants.
   - Alternatively, when `filterByOcclusion` encounters an occluded node that still has surviving children, keep the container and only drop descendants that are also marked occluded.
2. Add guardrails so structural scaffolding (`html`, `body`, frames, semantic containers) is never dropped solely due to occlusion; keep them to preserve tree integrity.
3. Instrument the metrics (`CompactionMetrics`) to log how many parents vs leaves are filtered, and flag cases where <5 nodes remain after Stage 1. This will make similar regressions obvious during testing.

## Next Steps
- Update `PaintOrderFilter` with the sibling-aware occlusion pass (or container guard) and rerun serialization against `.debug/x_com_virtual_node.json` to confirm the full tree survives.
- Once fixed, add a regression test that feeds a captured X.com DOM through the pipeline and asserts that structural roots (`html`, `body`) and interactive nodes remain.
