// popup.js — DuperMemory Popup Dashboard
//
// Reads all stored conversation memories from chrome.storage.local
// and renders them as cards. Provides per-conversation and global clear.

(function () {
  var cardsEl   = document.getElementById("cards");
  var clearAll  = document.getElementById("clear-all");

  function load() {
    chrome.storage.local.get(null, function (data) {
      if (chrome.runtime.lastError) {
        cardsEl.innerHTML = '<div class="empty">Failed to load memories.</div>';
        return;
      }

      var memories = [];
      for (var key in data) {
        if (key.indexOf("dupermemory_") === 0) {
          memories.push(data[key]);
        }
      }

      memories.sort(function (a, b) {
        return (b.updated_at || "").localeCompare(a.updated_at || "");
      });

      if (memories.length === 0) {
        cardsEl.innerHTML = '<div class="empty">No conversation memories yet.</div>';
        clearAll.style.display = "none";
        return;
      }

      clearAll.style.display = "";
      cardsEl.innerHTML = "";
      for (var i = 0; i < memories.length; i++) {
        cardsEl.appendChild(renderCard(memories[i]));
      }
    });
  }

  function renderCard(mem) {
    var card = document.createElement("div");
    card.className = "card";

    var topic   = mem.topic || "(untitled)";
    var goal    = mem.user_goal || "";
    var ents    = (mem.entities || []).length;
    var decs    = (mem.decisions || []).length;
    var iters   = mem.iteration_count || 0;
    var updated = mem.updated_at ? relTime(mem.updated_at) : "unknown";
    var convId  = mem.conversation_id || "";

    card.innerHTML =
      '<div class="card-topic">' + esc(topic) + '</div>' +
      (goal ? '<div class="card-goal">' + esc(goal) + '</div>' : '') +
      '<div class="card-stats">' +
        '<span><span class="stat-num">' + ents  + '</span> entities</span>' +
        '<span><span class="stat-num">' + decs  + '</span> decisions</span>' +
        '<span><span class="stat-num">' + iters + '</span> hops</span>' +
      '</div>' +
      '<div class="card-footer">' +
        '<span class="card-time">' + updated + '</span>' +
        '<button class="card-clear" data-id="' + esc(convId) + '">Clear</button>' +
      '</div>';

    card.querySelector(".card-clear").addEventListener("click", function () {
      var id = this.dataset.id;
      if (!id) return;
      chrome.storage.local.remove("dupermemory_" + id, load);
    });

    return card;
  }

  function relTime(iso) {
    try {
      var ms  = Date.now() - new Date(iso).getTime();
      var min = Math.floor(ms / 60000);
      if (min < 1)  return "just now";
      if (min < 60) return min + "m ago";
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + "h ago";
      var d = Math.floor(hr / 24);
      if (d < 7) return d + "d ago";
      return new Date(iso).toLocaleDateString();
    } catch (e) { return "unknown"; }
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  clearAll.addEventListener("click", function () {
    chrome.storage.local.get(null, function (data) {
      var keys = [];
      for (var k in data) {
        if (k.indexOf("dupermemory_") === 0) keys.push(k);
      }
      if (keys.length === 0) return;
      chrome.storage.local.remove(keys, load);
    });
  });

  load();
})();
