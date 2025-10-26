const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const moment = require('moment');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 미들웨어
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// JWT 시크릿
const JWT_SECRET = process.env.JWT_SECRET || 'outbound_b4ubiz_digital_signage_2024';

// 메모리 데이터베이스
let users = [
  { id: 1, name: '김민수', password: '1234', role: 'employee', department: '영업팀' },
  { id: 2, name: '이지연', password: '1234', role: 'employee', department: '마케팅팀' },
  { id: 3, name: '박성훈', password: '1234', role: 'employee', department: '개발팀' },
  { id: 4, name: '정유진', password: '1234', role: 'employee', department: '디자인팀' },
  { id: 5, name: '최태영', password: '1234', role: 'employee', department: '영업팀' },
  { id: 6, name: '한소희', password: '1234', role: 'employee', department: '관리팀' },
  { id: 7, name: '윤도현', password: '1234', role: 'admin', department: '관리팀' }
];

let outbounds = [];
let systemLogs = [];
let calendarEvents = [];

// 샘플 캘린더 데이터 생성
function generateSampleCalendarEvents() {
  const today = new Date();
  return [
    {
      id: 1,
      summary: '🔄 아침 조회',
      start: { dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0).toISOString() },
      end: { dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 30).toISOString() },
      color: '#4285F4'
    },
    {
      id: 2,
      summary: '📊 고객사 A 정기 미팅',
      start: { dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 14, 0).toISOString() },
      end: { dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16, 0).toISOString() },
      color: '#EA4335'
    },
    {
      id: 3,
      summary: '💡 신제품 브리핑',
      start: { dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16, 30).toISOString() },
      end: { dateTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 17, 30).toISOString() },
      color: '#34A853'
    }
  ];
}

// 상태별 색상 코드
const STATUS_COLORS = {
  'office': '#4285F4',      // 파란색 - 사무실
  'outbound': '#FBBC05',    // 주황색 - 외근 중
  'returned': '#9AA0A6',    // 회색 - 귀사 완료
  'absent': '#EA4335',      // 빨간색 - 미등록/지각
  'vacation': '#8E44AD'     // 보라색 - 휴가
};

// 인증 미들웨어
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// API 라우트

// 로그인
app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  const user = users.find(u => u.name === name && u.password === password);
  
  if (user) {
    const token = jwt.sign(
      { 
        id: user.id, 
        name: user.name, 
        role: user.role 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // 로그 기록
    systemLogs.push({
      userId: user.id,
      userName: user.name,
      action: 'login',
      timestamp: new Date(),
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        role: user.role,
        department: user.department
      } 
    });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// 외근 기록 생성
app.post('/api/outbounds', authenticateToken, (req, res) => {
  const { location, outTime, expectedReturnTime } = req.body;
  
  const outbound = {
    id: Date.now(),
    userId: req.user.id,
    userName: req.user.name,
    department: users.find(u => u.id === req.user.id)?.department || '',
    outTime: new Date(outTime),
    expectedReturnTime: expectedReturnTime ? new Date(expectedReturnTime) : null,
    location,
    status: 'outbound',
    createdAt: new Date()
  };
  
  outbounds.push(outbound);
  
  // 실시간 업데이트
  io.emit('outboundUpdate', getCurrentOutbounds());
  io.emit('statusUpdate', getStatusSummary());
  
  // 로그 기록
  systemLogs.push({
    userId: req.user.id,
    userName: req.user.name,
    action: `outbound_created: ${location}`,
    timestamp: new Date(),
    ip: req.ip
  });
  
  res.json(outbound);
});

// 외근 기록 업데이트 (귀사)
app.put('/api/outbounds/:id/return', authenticateToken, (req, res) => {
  const outboundId = parseInt(req.params.id);
  const outbound = outbounds.find(o => o.id === outboundId);
  
  if (!outbound) {
    return res.status(404).json({ error: 'Outbound record not found' });
  }

  outbound.inTime = new Date();
  outbound.status = 'returned';
  
  // 실시간 업데이트
  io.emit('outboundUpdate', getCurrentOutbounds());
  io.emit('statusUpdate', getStatusSummary());
  
  // 로그 기록
  systemLogs.push({
    userId: req.user.id,
    userName: req.user.name,
    action: `outbound_returned: ${outbound.location}`,
    timestamp: new Date(),
    ip: req.ip
  });
  
  res.json(outbound);
});

// 외근 기록 삭제
app.delete('/api/outbounds/:id', authenticateToken, (req, res) => {
  const outboundId = parseInt(req.params.id);
  const outboundIndex = outbounds.findIndex(o => o.id === outboundId);
  
  if (outboundIndex === -1) {
    return res.status(404).json({ error: 'Outbound record not found' });
  }

  const deletedOutbound = outbounds.splice(outboundIndex, 1)[0];
  
  // 실시간 업데이트
  io.emit('outboundUpdate', getCurrentOutbounds());
  io.emit('statusUpdate', getStatusSummary());
  
  // 로그 기록
  systemLogs.push({
    userId: req.user.id,
    userName: req.user.name,
    action: `outbound_deleted: ${deletedOutbound.location}`,
    timestamp: new Date(),
    ip: req.ip
  });
  
  res.json({ message: 'Outbound record deleted successfully' });
});

// 현재 외근 현황 조회
app.get('/api/outbounds/current', (req, res) => {
  res.json(getCurrentOutbounds());
});

// 상태 요약 조회
app.get('/api/status/summary', (req, res) => {
  res.json(getStatusSummary());
});

// 캘린더 이벤트
app.get('/api/calendar/events', (req, res) => {
  if (calendarEvents.length === 0) {
    calendarEvents = generateSampleCalendarEvents();
  }
  res.json(calendarEvents);
});

// 관리자 통계
app.get('/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
  const { period = 'week' } = req.query;
  
  const stats = {
    period: period,
    totalUsers: users.length,
    summary: getStatusSummary(),
    userStats: users.map(user => {
      const userOutbounds = outbounds.filter(o => o.userId === user.id);
      const currentOutbound = userOutbounds.find(o => o.status === 'outbound');
      
      return {
        userName: user.name,
        department: user.department,
        totalOutbounds: userOutbounds.length,
        currentStatus: currentOutbound ? '외근 중' : '사무실',
        currentLocation: currentOutbound ? currentOutbound.location : '사무실',
        lastActivity: userOutbounds.length > 0 ? 
          moment(userOutbounds[userOutbounds.length - 1].createdAt).fromNow() : '기록 없음'
      };
    })
  };
  
  res.json(stats);
});

// 시스템 로그
app.get('/api/admin/logs', authenticateToken, requireAdmin, (req, res) => {
  const { limit = 100 } = req.query;
  res.json(systemLogs.slice(-limit).reverse());
});

// 사용자 관리
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  res.json(users.map(user => ({
    id: user.id,
    name: user.name,
    role: user.role,
    department: user.department
  })));
});

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 유틸리티 함수
function getCurrentOutbounds() {
  return outbounds
    .filter(o => o.status === 'outbound')
    .sort((a, b) => new Date(b.outTime) - new Date(a.outTime));
}

function getStatusSummary() {
  const userStatus = users.map(user => {
    const currentOutbound = outbounds.find(o => 
      o.userId === user.id && o.status === 'outbound'
    );
    
    let status = 'office';
    let statusText = '사무실';
    
    if (currentOutbound) {
      status = 'outbound';
      statusText = '외근 중';
    }
    
    // 근무 시간 체크 (9시~18시)
    const currentHour = new Date().getHours();
    const currentDay = new Date().getDay(); // 0: 일요일, 6: 토요일
    
    // 주말 체크
    if (currentDay === 0 || currentDay === 6) {
      status = 'vacation';
      statusText = '휴일';
    }
    // 근무 시간 외
    else if (currentHour < 9 || currentHour >= 18) {
      status = 'absent';
      statusText = '퇴근';
    }
    // 출근 시간 체크 (9시 이후 미출근)
    else if (currentHour >= 9 && !currentOutbound) {
      const todayOutbounds = outbounds.filter(o => 
        o.userId === user.id && 
        new Date(o.createdAt).toDateString() === new Date().toDateString()
      );
      
      if (todayOutbounds.length === 0) {
        status = 'absent';
        statusText = '미등록';
      }
    }
    
    return {
      userId: user.id,
      userName: user.name,
      department: user.department,
      status,
      statusText,
      color: STATUS_COLORS[status],
      currentLocation: currentOutbound ? currentOutbound.location : '사무실',
      lastUpdate: new Date()
    };
  });
  
  const summary = {
    total: users.length,
    office: userStatus.filter(s => s.status === 'office').length,
    outbound: userStatus.filter(s => s.status === 'outbound').length,
    returned: userStatus.filter(s => s.status === 'returned').length,
    absent: userStatus.filter(s => s.status === 'absent').length,
    vacation: userStatus.filter(s => s.status === 'vacation').length,
    users: userStatus
  };
  
  return summary;
}

// 매분 상태 업데이트
cron.schedule('* * * * *', () => {
  io.emit('statusUpdate', getStatusSummary());
  io.emit('timeUpdate', { 
    currentTime: new Date().toLocaleTimeString('ko-KR'),
    currentDate: new Date().toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    })
  });
});

// 소켓 연결
io.on('connection', (socket) => {
  console.log('📱 Client connected');
  
  // 초기 데이터 전송
  socket.emit('outboundUpdate', getCurrentOutbounds());
  socket.emit('statusUpdate', getStatusSummary());
  socket.emit('timeUpdate', { 
    currentTime: new Date().toLocaleTimeString('ko-KR'),
    currentDate: new Date().toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    })
  });
  
  socket.on('disconnect', () => {
    console.log('📱 Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Outbound Digital Signage System running on port ${PORT}`);
  console.log(`📧 Access: http://localhost:${PORT}`);
  console.log(`👥 Default password for all users: 1234`);
  console.log(`🔑 Admin: 윤도현 (password: 1234)`);
  console.log(`🎯 Designed for digital signage display`);
});