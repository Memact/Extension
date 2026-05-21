(function installCapturePageApi() {
  if (window.capture) {
    return;
  }

  const pendingRequests = new Map();
  let bridgeReady = false;
  let requestCounter = 0;

  function nextRequestId(prefix = "capture") {
    requestCounter += 1;
    return `${prefix}-${Date.now()}-${requestCounter}`;
  }

  function waitForBridgeReady(timeoutMs = 4000) {
    if (bridgeReady) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onReady);
        reject(new Error("Capture bridge is not ready on this page."));
      }, timeoutMs);

      function onReady(event) {
        if (event.source !== window) {
          return;
        }
        if (event.data?.type !== "MEMACT_EXTENSION_READY") {
          return;
        }
        bridgeReady = true;
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onReady);
        resolve();
      }

      window.addEventListener("message", onReady);
    });
  }

  function requestBridge(type, payload = {}, timeoutMs = 15000) {
    return waitForBridgeReady().then(
      () =>
        new Promise((resolve, reject) => {
          const requestId = nextRequestId(type.toLowerCase());
          const timeoutId = window.setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error(`Timed out waiting for ${type}.`));
          }, timeoutMs);

          pendingRequests.set(requestId, {
            resolve,
            reject,
            timeoutId,
          });

          window.postMessage(
            {
              type,
              payload,
              requestId,
            },
            window.location.origin
          );
        })
    );
  }

  function finishPending(requestId, fn) {
    const entry = pendingRequests.get(requestId);
    if (!entry) {
      return;
    }
    pendingRequests.delete(requestId);
    window.clearTimeout(entry.timeoutId);
    fn(entry);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data || {};
    if (data.type === "MEMACT_EXTENSION_READY") {
      bridgeReady = true;
      return;
    }

    if (!data.requestId) {
      return;
    }

    if (data.type === "MEMACT_ERROR") {
      finishPending(data.requestId, ({ reject }) => {
        reject(new Error(String(data.error || "Capture bridge failed.")));
      });
      return;
    }

    if (!/_RESULT$/.test(String(data.type || ""))) {
      return;
    }

    finishPending(data.requestId, ({ resolve }) => {
      resolve(data);
    });
  });

  async function expectCaptureResponse(type, payload = {}) {
    const result = await requestBridge(type, payload);
    const response = result?.response;
    if (!response?.ok) {
      throw new Error(String(response?.error || `${type} failed.`));
    }
    return response;
  }

  window.capture = {
    isReady() {
      return bridgeReady;
    },
    waitUntilReady(timeoutMs = 4000) {
      return waitForBridgeReady(timeoutMs).then(() => true);
    },
    async getEvents(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_EVENTS", options);
      return Array.isArray(response.events) ? response.events : [];
    },
    async getSessions(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_SESSIONS", options);
      return Array.isArray(response.sessions) ? response.sessions : [];
    },
    async getActivities(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_ACTIVITIES", options);
      return Array.isArray(response.activities) ? response.activities : [];
    },
    async getContentUnits(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_CONTENT_UNITS", options);
      return Array.isArray(response.content_units) ? response.content_units : [];
    },
    async getGraphPackets(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_GRAPH_PACKETS", options);
      return Array.isArray(response.graph_packets) ? response.graph_packets : [];
    },
    async getMediaJobs(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_MEDIA_JOBS", options);
      return Array.isArray(response.media_jobs) ? response.media_jobs : [];
    },
    async getSnapshot(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_GET_SNAPSHOT", options);
      return response.snapshot || null;
    },
    async getBootstrapStatus() {
      const response = await expectCaptureResponse("CAPTURE_BOOTSTRAP_STATUS", {});
      return response.bootstrap || null;
    },
    async bootstrapHistory(options = {}) {
      const response = await expectCaptureResponse("CAPTURE_BOOTSTRAP_HISTORY", options);
      return response.bootstrap || null;
    },
    async exportSnapshot(options = {}) {
      const snapshot = await this.getSnapshot(options);
      if (!snapshot) {
        throw new Error("Capture did not return a snapshot.");
      }
      return snapshot;
    },
    async downloadSnapshot() {
      throw new Error("Capture no longer downloads snapshots. Use getSnapshot() or exportSnapshot() to read the bridge snapshot.");
    },
  };

  window.dispatchEvent(
    new CustomEvent("capture-ready", {
      detail: {
        bridgeReady: () => bridgeReady,
      },
    })
  );
})();
