/*
OUTBOUND.B4UBIZ - Office Attendance & Fieldwork Board

UPDATED: Fixed runtime error "Service firestore is not available" by adding safe Firebase initialization
and a local in-memory fallback (mock DB) when Firebase is not configured or Firestore is unavailable.

Changes summary:
- Delay calling getFirestore() until after validating FIREBASE_CONFIG.
- If FIREBASE_CONFIG is left as placeholders, the app will use a localStorage-backed mock DB so the UI still works for development/testing.
- All Firestore calls (onSnapshot, setDoc, addDoc, runTransaction, query, orderBy, limit) are wrapped and mapped to the mock implementation when needed.
- Added clear console warnings explaining that the app is running in mock mode and instructions to wire Firebase.
- Kept original UI and behaviors intact; behavior with real Firestore remains unchanged when proper config is provided.

NOTE: This file is intended as a single-file React component. For production, configure Firebase credentials and remove the demo PINs/mock DB.
*/

import React, { useEffect, useState, useRef } from "react";

// Import firebase *types* (modular SDK). We will only call functions conditionally.
import { initializeApp } from "firebase/app";
// The following imports are used only when Firestore is actually initialized.
import {
  getFirestore as _getFirestore,
  collection as _collection,
  doc as _doc,
  setDoc as _setDoc,
  getDoc as _getDoc,
  onSnapshot as _onSnapshot,
  addDoc as _addDoc,
  serverTimestamp as _serverTimestamp,
  runTransaction as _runTransaction,
  query as _query,
  orderBy as _orderBy,
  limit as _limit,
} from "firebase/firestore";
import { getAuth as _getAuth } from "firebase/auth";

// ====== PLACEHOLDERS (REPLACE BEFORE DEPLOY) ======
const FIREBASE_CONFIG = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_FIREBASE_AUTH_DOMAIN",
  projectId: "YOUR_FIREBASE_PROJECT_ID",
  storageBucket: "YOUR_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "YOUR_FIREBASE_MSG_SENDER_ID",
  appId: "YOUR_FIREBASE_APP_ID",
};

const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"; // if using gapi
const GOOGLE_API_KEY = "YOUR_GOOGLE_API_KEY"; // optional for calendar API

// The 7 employees — adjust names to match your staff
const EMPLOYEES = ["Kim", "Lee", "Park", "Choi", "Jung", "Han", "Yoon"];

// For demo-only kiosk PINs (not secure). In production use Firebase Auth or server-side auth.
const DEMO_PINS = {
  Kim: "1111",
  Lee: "2222",
  Park: "3333",
  Choi: "4444",
  Jung: "5555",
  Han: "6666",
  Yoon: "7777",
  admin: "0000",
};

// ====== Safe Firebase initialization ======
let firebaseApp = null;
let db = null;
let auth = null;
let useMockDb = false;

function isFirebaseConfigValid(cfg) {
  // Basic check: projectId and apiKey must be replaced
  return cfg && cfg.projectId && !cfg.projectId.startsWith("YOUR_") && cfg.apiKey && !cfg.apiKey.startsWith("YOUR_");
}

if (isFirebaseConfigValid(FIREBASE_CONFIG)) {
  try {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
    // try to initialize Firestore and Auth; wrap in try/catch because environment may not include Firestore
    try {
      db = _getFirestore(firebaseApp);
      auth = _getAuth(firebaseApp);
      console.info("Firebase initialized: Firestore available.");
    } catch (e) {
      console.warn("Firestore initialization failed. Falling back to mock DB. Error:", e);
      useMockDb = true;
    }
  } catch (e) {
    console.warn("Firebase initializeApp failed, falling back to mock DB:", e);
    useMockDb = true;
  }
} else {
  console.warn("Firebase config is placeholder or missing. Running in MOCK DB mode.\nReplace FIREBASE_CONFIG with your Firebase project credentials to enable Firestore.");
  useMockDb = true;
}

// ====== Mock DB implementation (localStorage-backed simple store) ======
// Provides: collection, docRef (simple object with id), onSnapshot (polling based), setDoc, addDoc, serverTimestamp, runTransaction, query helpers

function makeMockDB() {
  const STORAGE_KEY = "outbound_mock_db_v1";

  // Load or create base data
  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { outbound_records: {}, outbound_logs: {} };
      return JSON.parse(raw);
    } catch (e) {
      console.warn("mockdb read error", e);
      return { outbound_records: {}, outbound_logs: {} };
    }
  }

  function writeStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  // ensure keys exist
  const ensure = () => {
    const s = readStore();
    if (!s.outbound_records) s.outbound_records = {};
    if (!s.outbound_logs) s.outbound_logs = {};
    writeStore(s);
  };
  ensure();

  function collectionMock(name) {
    return { __mockCollection: name };
  }

  function docMock(col, id) {
    return { __mockDoc: true, col: col.__mockCollection || col, id };
  }

  function getDataSnapshotForCollection(colName) {
    const s = readStore();
    return s[colName] || {};
  }

  function onSnapshotMock(queryObj, cb) {
    // very naive: call cb immediately with snapshot-like object and then poll every 2s for changes
    let last = null;
    let stopped = false;

    function buildSnap(colName) {
      const data = getDataSnapshotForCollection(colName);
      const docs = Object.keys(data).map((id) => ({ id, data: () => data[id] }));
      return { forEach: (fn) => docs.forEach((d) => fn({ id: d.id, data: () => data[d.id] })), docs };
    }

    const colName = queryObj.__mockCollection || (queryObj && queryObj.collectionName) || null;
    // initial
    setTimeout(() => cb(buildSnap(colName)), 0);

    const iv = setInterval(() => {
      if (stopped) return;
      cb(buildSnap(colName));
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }

  async function setDocMock(docRef, data, opts) {
    const store = readStore();
    const col = docRef.col;
    store[col] = store[col] || {};
    const id = docRef.id || data.name || `doc_${Date.now()}`;
    store[col][id] = Object.assign({}, store[col][id] || {}, data);
    writeStore(store);
    return Promise.resolve();
  }

  async function addDocMock(colRef, data) {
    const store = readStore();
    const col = colRef.__mockCollection;
    store[col] = store[col] || {};
    const id = `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    store[col][id] = Object.assign({}, data, { id });
    writeStore(store);
    return Promise.resolve({ id });
  }

  function serverTimestampMock() {
    return new Date().toISOString();
  }

  async function runTransactionMock(dbRef, updateFn) {
    // naive: call updateFn with a tx-like object that has get, set, update
    const store = readStore();
    const tx = {
      get: async (docRef) => {
        const col = docRef.col;
        const id = docRef.id;
        const data = (store[col] && store[col][id]) || null;
        return { exists: !!data, data: () => data };
      },
      set: async (docRef, newData, opts) => {
        store[docRef.col] = store[docRef.col] || {};
        const id = docRef.id || newData.name || `doc_${Date.now()}`;
        store[docRef.col][id] = Object.assign({}, store[docRef.col][id] || {}, newData);
      },
      update: async (docRef, fields) => {
        store[docRef.col] = store[docRef.col] || {};
        const id = docRef.id;
        store[docRef.col][id] = Object.assign({}, store[docRef.col][id] || {}, fields);
      },
    };
    await updateFn(tx);
    writeStore(store);
    return Promise.resolve();
  }

  function queryMock(colRef) {
    // return the collection object itself so onSnapshot can use __mockCollection
    return colRef;
  }

  function orderByMock() { return null; }
  function limitMock() { return null; }

  return {
    collection: collectionMock,
    doc: docMock,
    setDoc: setDocMock,
    addDoc: addDocMock,
    onSnapshot: onSnapshotMock,
    serverTimestamp: serverTimestampMock,
    runTransaction: runTransactionMock,
    query: queryMock,
    orderBy: orderByMock,
    limit: limitMock,
  };
}

const mockDB = useMockDb ? makeMockDB() : null;

// Exported wrappers that map to real Firestore functions if available, otherwise to mock implementations.
const collection = (...args) => {
  if (!useMockDb) return _collection(db, ...args);
  return mockDB.collection(args[0]);
};
const doc = (...args) => {
  if (!useMockDb) return _doc(db, ...args);
  // doc(collectionName, id)
  if (args.length === 2) return mockDB.doc(mockDB.collection(args[0]), args[1]);
  if (args.length === 1) return mockDB.doc(args[0], null);
  return mockDB.doc(args[0], args[1]);
};
const setDoc = (...args) => {
  if (!useMockDb) return _setDoc(...args);
  return mockDB.setDoc(...args);
};
const addDoc = (...args) => {
  if (!useMockDb) return _addDoc(...args);
  return mockDB.addDoc(...args);
};
const onSnapshot = (...args) => {
  if (!useMockDb) return _onSnapshot(...args);
  return mockDB.onSnapshot(...args);
};
const serverTimestamp = () => {
  if (!useMockDb) return _serverTimestamp();
  return mockDB.serverTimestamp();
};
const runTransaction = (...args) => {
  if (!useMockDb) return _runTransaction(db, ...args);
  return mockDB.runTransaction(...args);
};
const query = (...args) => {
  if (!useMockDb) return _query(...args);
  return mockDB.query(...args);
};
const orderBy = (...args) => {
  if (!useMockDb) return _orderBy(...args);
  return mockDB.orderBy(...args);
};
const limit = (...args) => {
  if (!useMockDb) return _limit(...args);
  return mockDB.limit(...args);
};

// If using mock DB, log a helpful message
if (useMockDb) {
  console.info("OUTBOUND: Running in MOCK DB mode. Firestore is not active. Replace FIREBASE_CONFIG to enable Firestore.");
}

// ====== Utility helpers ======
const statusForRecord = (r) => {
  if (!r) return "unregistered";
  if (r.status === "in") return "in"; // at office
  if (r.status === "out") return "out"; // out on field
  if (r.status === "returned") return "returned"; // back
  if (r.late) return "late";
  return "unregistered";
};

const statusColor = (status) => {
  switch (status) {
    case "in":
      return "bg-blue-500 text-white";
    case "out":
      return "bg-orange-500 text-white";
    case "returned":
      return "bg-gray-400 text-white";
    case "late":
      return "bg-red-600 text-white";
    default:
      return "bg-red-600 text-white";
  }
};

// format time helper
const fmtTime = (iso) => {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "-";
  }
};

// ====== Main App Component ======
export default function OutboundBoardApp() {
  const [selectedName, setSelectedName] = useState(null);
  const [pin, setPin] = useState("");
  const [currentUser, setCurrentUser] = useState(null); // {name, uid}
  const [records, setRecords] = useState({}); // name -> record
  const [loading, setLoading] = useState(true);
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [calendarUrl, setCalendarUrl] = useState("");
  const [kioskMode, setKioskMode] = useState(false); // detect kiosk (large screen) vs personal device
  const [logs, setLogs] = useState([]);

  // realtime subscription
  useEffect(() => {
    // subscribe to 'outbound_records' collection
    let unsub = () => {};
    let unsub2 = () => {};
    try {
      const q = query(collection("outbound_records"));
      unsub = onSnapshot(q, (snap) => {
        const map = {};
        snap.forEach((docSnap) => {
          map[docSnap.id] = docSnap.data ? docSnap.data() : docSnap; // mock snapshot provides data via object
        });
        setRecords(map);
        setLoading(false);
      });

      // subscribe logs (last 50 entries)
      const q2 = query(collection("outbound_logs"), orderBy("ts", "desc"), limit(50));
      unsub2 = onSnapshot(q2, (snap) => {
        const arr = [];
        snap.forEach((s) => arr.push({ id: s.id, ...(s.data ? s.data() : s) }));
        setLogs(arr);
      });
    } catch (e) {
      console.error("subscription error", e);
    }

    return () => {
      try { unsub(); } catch (e) {}
      try { unsub2(); } catch (e) {}
    };
  }, []);

  useEffect(() => {
    // quick detection of "kiosk" based on window size
    setKioskMode(typeof window !== "undefined" && window.innerWidth >= 1200);
  }, []);

  // ====== Auth / Login (simple demo using PIN)
  const handleSelectName = (name) => {
    setSelectedName(name);
    setPin("");
  };

  const handleSubmitPin = async () => {
    if (!selectedName) return;
    // demo validation
    if (DEMO_PINS[selectedName] && DEMO_PINS[selectedName] === pin) {
      setCurrentUser({ name: selectedName, uid: `user_${selectedName}` });
      setSelectedName(null);
      setPin("");
      await writeLog(`${selectedName} logged in (PIN)`);
    } else if (selectedName === "admin" && pin === DEMO_PINS.admin) {
      setIsAdminMode(true);
      setCurrentUser({ name: "admin", uid: "admin" });
      setShowAdminPanel(true);
      await writeLog(`admin logged in`);
    } else {
      alert("Wrong PIN");
    }
  };

  // ====== Write record (enter out / return / delete) with concurrency handling ======
  async function markOut(name, place) {
    const now = new Date().toISOString();
    const docRef = doc("outbound_records", name);
    try {
      await runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        const data = snap && snap.exists ? snap.data() : (snap || null);
        const newData = {
          name,
          outAt: now,
          returnAt: data ? data.returnAt : null,
          place: place || "(unspecified)",
          status: "out",
          lastUpdated: serverTimestamp(),
        };
        // Note: for mock, tx.set will store
        await tx.set(docRef, newData, { merge: true });
      });
      await writeLog(`${name} marked OUT at ${now} to ${place}`);
    } catch (e) {
      console.error(e);
      alert("Failed to mark out - try again");
    }
  }

  async function markReturn(name) {
    const now = new Date().toISOString();
    const docRef = doc("outbound_records", name);
    try {
      await runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap || !snap.exists) {
          await tx.set(docRef, {
            name,
            outAt: null,
            returnAt: now,
            place: null,
            status: "returned",
            lastUpdated: serverTimestamp(),
          });
        } else {
          await tx.update(docRef, {
            returnAt: now,
            status: "returned",
            lastUpdated: serverTimestamp(),
          });
        }
      });
      await writeLog(`${name} RETURNED at ${now}`);
    } catch (e) {
      console.error(e);
      alert("Failed to mark return - try again");
    }
  }

  async function deleteRecord(name) {
    const docRef = doc("outbound_records", name);
    try {
      // for soft-delete, we set status to unregistered and clear fields
      await setDoc(
        docRef,
        {
          name,
          outAt: null,
          returnAt: null,
          place: null,
          status: "unregistered",
          lastUpdated: serverTimestamp(),
        },
        { merge: true }
      );
      await writeLog(`${name} record cleared`);
    } catch (e) {
      console.error(e);
      alert("Delete failed");
    }
  }

  async function writeLog(text) {
    try {
      await addDoc(collection("outbound_logs"), {
        text,
        ts: serverTimestamp(),
      });
    } catch (e) {
      console.error("log write failed", e);
    }
  }

  // ====== Admin helpers ======
  const addEmployee = async (name) => {
    if (!name) return;
    await setDoc(doc("outbound_records", name), {
      name,
      status: "unregistered",
      createdAt: serverTimestamp(),
    });
    await writeLog(`Admin added employee ${name}`);
  };

  const removeEmployee = async (name) => {
    await setDoc(doc("outbound_records", name), {
      status: "removed",
      lastUpdated: serverTimestamp(),
    }, { merge: true });
    await writeLog(`Admin removed employee ${name}`);
  };

  // ====== Google Calendar fetch skeleton (you must wire gapi) ======
  async function fetchGoogleCalendarEvents() {
    setCalendarUrl("https://calendar.google.com/calendar/embed?src=YOUR_PUBLIC_CALENDAR_ID&ctz=Asia/Seoul");
  }

  useEffect(() => { fetchGoogleCalendarEvents(); }, []);

  // ====== Derived stats ======
  const stats = React.useMemo(() => {
    let inCount = 0, outCount = 0, returnedCount = 0, unreg = 0;
    Object.keys(records).forEach((k) => {
      const r = records[k];
      if (!r || !r.status || r.status === "unregistered") unreg++;
      else if (r.status === "in") inCount++;
      else if (r.status === "out") outCount++;
      else if (r.status === "returned") returnedCount++;
    });
    return { inCount, outCount, returnedCount, unreg };
  }, [records]);

  // ====== UI pieces ======
  function LoginPanel() {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-2">Quick login</h3>
        <div className="grid grid-cols-3 gap-2">
          {EMPLOYEES.map((n) => (
            <button key={n} onClick={() => handleSelectName(n)} className="p-2 rounded-lg border hover:scale-105 transition-transform">{n}</button>
          ))}
          <button onClick={() => handleSelectName("admin")} className="p-2 rounded-lg border col-span-3 bg-gray-100">Admin</button>
        </div>

        {selectedName && (
          <div className="mt-4">
            <div className="mb-1">Enter PIN for {selectedName}</div>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} className="border p-2 rounded w-full" />
            <div className="flex gap-2 mt-2">
              <button onClick={handleSubmitPin} className="px-4 py-2 bg-blue-600 text-white rounded">Submit</button>
              <button onClick={() => { setSelectedName(null); setPin(""); }} className="px-4 py-2 border rounded">Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function RecordRow({ name, data }) {
    const st = statusForRecord(data);
    return (
      <div className={`p-3 rounded-lg mb-2 shadow-sm flex items-center justify-between transition-all duration-300 ${statusColor(st)}`}>
        <div>
          <div className="font-semibold">{name}</div>
          <div className="text-sm">Out: {fmtTime(data?.outAt)} | Return: {fmtTime(data?.returnAt)} | {data?.place || "-"}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => {
              const place = prompt("외근처를 입력하세요:", data?.place || "");
              if (place !== null) markOut(name, place);
            }} className="px-3 py-1 rounded bg-white text-black">출사</button>
          <button onClick={() => { markReturn(name); }} className="px-3 py-1 rounded bg-white text-black">귀사</button>
          <button onClick={() => { if (confirm("정말 삭제(초기화)하시겠습니까?")) deleteRecord(name); }} className="px-3 py-1 rounded bg-red-700 text-white">삭제</button>
        </div>
      </div>
    );
  }

  function AdminPanel() {
    const [newName, setNewName] = useState("");
    return (
      <div className="p-4 bg-white rounded shadow-lg">
        <h3 className="font-semibold mb-2">관리자 패널</h3>
        <div className="mb-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="추가할 사원명" className="border p-2 rounded w-full" />
          <div className="flex gap-2 mt-2">
            <button onClick={async () => { await addEmployee(newName); setNewName(""); }} className="px-3 py-1 rounded bg-blue-600 text-white">추가</button>
            <button onClick={async () => { if (newName) await removeEmployee(newName); setNewName(""); }} className="px-3 py-1 rounded border">삭제</button>
          </div>
        </div>

        <div className="mb-2">
          <h4 className="font-medium">주간 / 월간 통계 (예시)</h4>
          <p className="text-sm">통계는 서버(Cloud Function 등)에서 집계해 Firestore에 저장하는 것을 권장합니다. 이 UI에서는 최근 기록 샘플을 표시합니다.</p>
          <div className="mt-2 max-h-40 overflow-auto">
            {logs.map((l) => (
              <div key={l.id} className="text-xs border-b py-1">{new Date(l.ts || Date.now()).toLocaleString()} - {l.text}</div>
            ))}
          </div>
        </div>

      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 bg-gradient-to-r from-slate-50 to-white">
      <div className="max-w-[1400px] mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="grid grid-cols-12">
          {/* LEFT: Google Calendar */}
          <div className="col-span-7 border-r p-4">
            <div className="flex justify-between items-center mb-3">
              <div className="text-xl font-bold">Company Calendar</div>
              <div className="text-sm text-gray-500">(Left: Google Calendar) </div>
            </div>
            <div className="h-[80vh] rounded-lg overflow-hidden border">
              {/* If you have a public embed URL use iframe. Otherwise hook up the gapi calendar list. */}
              {calendarUrl ? (
                <iframe title="company-calendar" src={calendarUrl} className="w-full h-full" />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400">Calendar not configured — set PUBLIC embed or wire Google Calendar API</div>
              )}
            </div>
          </div>

          {/* RIGHT: status board */}
          <div className="col-span-5 p-4 relative">
            <div className="flex justify-between items-center mb-3">
              <div>
                <div className="text-2xl font-bold">외근 상황표</div>
                <div className="text-sm text-gray-500">{new Date().toLocaleDateString()} • <span className="font-mono">{new Date().toLocaleTimeString()}</span></div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-sm">Summary</div>
                <div className="px-2 py-1 bg-blue-100 rounded">사무실: {stats.inCount}</div>
                <div className="px-2 py-1 bg-orange-100 rounded">외근: {stats.outCount}</div>
                <div className="px-2 py-1 bg-gray-100 rounded">귀사: {stats.returnedCount}</div>
              </div>
            </div>

            <div className="h-[62vh] overflow-auto pr-2">
              {/* list each employee - if no record, show default */}
              {EMPLOYEES.map((n) => (
                <RecordRow key={n} name={n} data={records[n] || { status: "unregistered" }} />
              ))}
            </div>

            <div className="mt-3 flex gap-2">
              <LoginPanel />
            </div>

            {/* Admin gear */}
            <button onClick={() => setShowAdminPanel((s) => !s)} className="absolute bottom-4 right-4 p-3 rounded-full bg-gray-800 text-white shadow-lg">⚙</button>

            {showAdminPanel && (
              <div className="absolute top-10 right-4 w-80"><AdminPanel /></div>
            )}

          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto mt-4 text-sm text-gray-600">
        <div>Notes:</div>
        <ul className="list-disc ml-6">
          <li>자동 동기화: Google Calendar 연동 코드를 연결하면 좌측 캘린더의 일정을 자동으로 파싱해 외근 상황으로 반영할 수 있습니다.</li>
          <li>실시간 반영 및 충돌 방지: Firestore의 트랜잭션과 onSnapshot을 이용해 동시 편집 안전성을 확보합니다.</li>
          <li>로그 및 통계: 모든 변경은 outbound_logs 컬렉션에 기록되어 관리자가 주간/월간 통계를 집계할 수 있습니다 (Cloud Function 권장).</li>
        </ul>
      </div>
    </div>
  );
}

/*
-- END OF FILE --

Deployment & Integration checklist (short):
1) Replace FIREBASE_CONFIG constants with your Firebase project's credentials.
2) Configure Firestore rules to allow appropriate read/write for authenticated users.
3) For secure admin features, implement Firebase Auth and admin claims rather than demo PINs.
4) To auto-import Google Calendar events, implement a server-side worker using a Service Account (recommended) that writes events into `outbound_records` when matching employee names or event metadata.
5) Consider putting a small server (Cloud Function) to translate Google Calendar events into outbound_records and to export weekly/monthly stats.
6) Configure outbound.b4ubiz.com DNS/Hosting (Firebase Hosting or other) and add to Google OAuth allowed origins.
*/
