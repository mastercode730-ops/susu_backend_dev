const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { calculateGameResult } = require('../utils/resultCalculator');

router.get('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeQuery(
      `SELECT GID, GameName, CONVERT(varchar(5), DrawTime, 108) AS DrawTime,
              IsNextDayResult, IsAcceptedStatus, IsActive, IsRejectedMsg, fUID
       FROM Game
       WHERE fUID = @uid
       ORDER BY GID ASC`,
      { uid: parseInt(uid) }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { gameName, drawTime, isActive, isNextDay, isNextDayResult, isAcceptedStatus, isRejectedMsg } = req.body;
    if (!gameName) return res.status(400).json({ success: false, message: 'Game name required' });
    const nextDay = isNextDayResult !== undefined ? isNextDayResult : isNextDay;
    const active = isActive !== undefined ? isActive : true;
    await executeStoredProcedure('CreateGames', {
      fId: uid,
      GameName: gameName,
      DrawTime: drawTime || null,
      IsActive: (active === true || active === 'True' || active === 1) ? true : false,
      IsNextDay: (nextDay === true || nextDay === 'True' || nextDay === 1) ? true : false,
      IsAcceptedStatus: (isAcceptedStatus === true || isAcceptedStatus === 'True' || isAcceptedStatus === 1) ? true : false,
      IsRejectedMsg: (isRejectedMsg === true || isRejectedMsg === 'True' || isRejectedMsg === 1) ? true : false
    });
    res.json({ success: true, message: 'Game created' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:gid', requireAuth, async (req, res) => {
  try {
    const { gameName, drawTime, isActive, isNextDay, isNextDayResult, isAcceptedStatus, isRejectedMsg } = req.body;
    const nextDay = isNextDayResult !== undefined ? isNextDayResult : isNextDay;
    const active = isActive !== undefined ? isActive : true;
    await executeQuery(
      `UPDATE Game SET 
        GameName = @gameName, 
        DrawTime = @drawTime, 
        IsActive = @isActive, 
        IsNextDayResult = @isNextDayResult, 
        IsAcceptedStatus = @isAcceptedStatus, 
        IsRejectedMsg = @isRejectedMsg 
       WHERE GID = @gid`,
      {
        gid: parseInt(req.params.gid),
        gameName,
        drawTime: drawTime || null,
        isActive: (active === true || active === 'True' || active === 1) ? 'True' : 'False',
        isNextDayResult: (nextDay === true || nextDay === 'True' || nextDay === 1) ? 'True' : 'False',
        isAcceptedStatus: (isAcceptedStatus === true || isAcceptedStatus === 'True' || isAcceptedStatus === 1) ? 'True' : 'False',
        isRejectedMsg: (isRejectedMsg === true || isRejectedMsg === 'True' || isRejectedMsg === 1) ? 'True' : 'False'
      }
    );
    res.json({ success: true, message: 'Game updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:gid', requireAuth, async (req, res) => {
  try {
    await executeQuery(`DELETE FROM Game WHERE GID=@gid`, { gid: parseInt(req.params.gid) });
    res.json({ success: true, message: 'Game deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/toggle', requireAuth, async (req, res) => {
  try {
    const { gid, field, value } = req.body;
    const allowed = ['IsActive', 'IsNextDayResult', 'IsAcceptedStatus', 'IsRejectedMsg'];
    if (!allowed.includes(field)) return res.status(400).json({ success: false, message: 'Invalid field' });
    await executeQuery(`UPDATE Game SET ${field}=@value WHERE GID=@gid`, {
      gid: parseInt(gid),
      value: (value === true || value === 'True' || value === 1) ? 'True' : 'False'
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/game/list
router.get('/list', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeStoredProcedure('FetchGames', { fId: uid });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Helper: normalize any date format to YYYY-MM-DD string
function parseDateStr(s) {
  if (!s) return '';
  if (s instanceof Date) {
    if (isNaN(s.getTime())) return '';
    return s.toISOString().split('T')[0];
  }
  const str = String(s).trim();
  const iso = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  const mo = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const m1 = str.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})/i);
  if (m1 && mo[m1[2].toLowerCase()]) return `${m1[3]}-${mo[m1[2].toLowerCase()]}-${String(m1[1]).padStart(2, '0')}`;
  return str.substring(0, 10);
}

// GET /api/game/result?gid=X&date=X
router.get('/result', requireAuth, async (req, res) => {
  try {
    const { gid, date } = req.query;
    const dateStr = parseDateStr(date);
    const data = await executeQuery(
      `SELECT Result FROM Result WHERE fGameID=@gid AND CAST(Date AS date)=CAST(@date AS date)`,
      { gid: parseInt(gid), date: dateStr }
    );
    res.json({ success: true, data: data?.[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/game/save-result
router.post('/save-result', requireAuth, async (req, res) => {
  try {
    const { gameID, result, date } = req.body;
    const gid = parseInt(gameID);
    const cleanResult = String(result || '').trim();

    if (!gid || !cleanResult) {
      return res.status(400).json({ success: false, message: 'Game and result required' });
    }

    let dateStr = parseDateStr(date);
    if (!dateStr) {
      const utcNow = new Date();
      const ist = new Date(utcNow.getTime() + (5.5 * 60 * 60 * 1000));
      const dtData = await executeStoredProcedure('GetChatDate', {
        fGameID: gid,
        MessageDateTime: ist
      });
      const gDate = dtData?.[0] ? Object.values(dtData[0])[0] : null;
      dateStr = parseDateStr(gDate) || parseDateStr(ist);
    }

    await calculateGameResult(gid, dateStr, cleanResult, req.user.UID);

    res.json({ success: true, message: 'Result saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/game/auto-accept-status?gid=X
router.get('/auto-accept-status', requireAuth, async (req, res) => {
  try {
    const { gid } = req.query;
    const data = await executeQuery(
      `SELECT IsAcceptedStatus FROM Game WHERE GID=@gid`,
      { gid: parseInt(gid) }
    );
    res.json({ success: true, data: data?.[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
