#!/bin/sh
# Remotion starts a detached browser group. When its worker closes stdin,
# stop that group, including native browser children and this launcher.
exec 3<&0
(
  while IFS= read -r ignored <&3; do :; done
  /bin/kill -KILL -- "-$$"
) &
watcher=$!
"$OPENCHATCUT_OWNED_CHROME" "$@" </dev/null 3<&- &
browser=$!
wait "$browser"
code=$?
kill "$watcher" 2>/dev/null
exit "$code"
