/*
 * /api/perangkat  —  pembatas jumlah perangkat per akun.
 *
 * Tanpa dependensi npm: cuma fetch bawaan Node 18+ di Vercel dan
 * Upstash Redis lewat REST.
 *
 * Variabel lingkungan yang dibaca (atur di Vercel > Settings > Environment Variables):
 *
 *   KV_REST_API_URL        \ dari integrasi Upstash/Vercel KV. Nama
 *   KV_REST_API_TOKEN      / UPSTASH_REDIS_REST_* juga diterima.
 *   AKUN_VERIFIKASI        JSON {"pengguna":"<sha256 hex>"} — dibuat oleh
 *                          tombol di halaman Atur situsnya.
 *   MAKS_PERANGKAT         opsional, bawaan 2.
 *   ADMIN_TOKEN            opsional, untuk melihat & melepas slot perangkat.
 *
 * Kalau AKUN_VERIFIKASI atau KV belum diisi, endpoint menjawab
 * { mati: true } dan situs jalan seperti biasa tanpa pembatasan.
 */

var URL_KV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var TOKEN_KV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var MAKS = parseInt(process.env.MAKS_PERANGKAT || "2", 10) || 2;
var ADMIN = process.env.ADMIN_TOKEN || "";

function daftarAkun() {
  try {
    var j = JSON.parse(process.env.AKUN_VERIFIKASI || "{}");
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    return {};
  }
}

/* AKUN_VERIFIKASI menerima dua bentuk: nilainya berupa string hash (bentuk
   lama) atau objek {h, ai}. Ambil hash-nya apa pun bentuknya. */
function hashAkun(nilai) {
  if (typeof nilai === "string") return nilai;
  if (nilai && typeof nilai === "object" && nilai.h) return String(nilai.h);
  return "";
}

async function redis(perintah) {
  var r = await fetch(URL_KV, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN_KV,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(perintah)
  });
  if (!r.ok) throw new Error("KV menjawab " + r.status);
  var j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function bersih(s, maks) {
  return String(s === undefined || s === null ? "" : s).slice(0, maks || 128);
}

// Perbandingan tanpa bocor lewat lama waktu eksekusi.
function samaAman(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var beda = 0;
  for (var i = 0; i < a.length; i++) beda |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return beda === 0;
}

function kunci(akun) { return "perangkat:" + akun; }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  var akunSah = daftarAkun();
  if (!URL_KV || !TOKEN_KV || !Object.keys(akunSah).length) {
    return res.status(200).json({ mati: true });
  }

  try {
    // --- pemilik: lihat / lepas slot ---
    if (req.method === "GET" || req.method === "DELETE") {
      var tokenMasuk = bersih(req.headers["x-admin-token"], 200);
      if (!ADMIN || !samaAman(tokenMasuk, ADMIN)) {
        return res.status(401).json({ galat: "Token admin tidak cocok." });
      }
      var badanAdmin = req.body || {};
      if (typeof badanAdmin === "string") {
        try { badanAdmin = JSON.parse(badanAdmin); } catch (e) { badanAdmin = {}; }
      }
      var akunQ = bersih(
        (req.query && req.query.akun) || badanAdmin.akun || "", 64
      ).toLowerCase();
      if (!akunQ) return res.status(400).json({ galat: "Sebutkan akun." });

      if (req.method === "GET") {
        var isi = await redis(["HGETALL", kunci(akunQ)]);
        var daftar = [];
        for (var i = 0; i < (isi || []).length; i += 2) {
          daftar.push({ sidik: isi[i], terakhir: Number(isi[i + 1]) || 0 });
        }
        return res.status(200).json({ akun: akunQ, maks: MAKS, perangkat: daftar });
      }

      var buang = bersih(badanAdmin.sidik, 80);
      if (!buang) {
        await redis(["DEL", kunci(akunQ)]);
        return res.status(200).json({ status: "dikosongkan", akun: akunQ });
      }
      await redis(["HDEL", kunci(akunQ), buang]);
      return res.status(200).json({ status: "dilepas", akun: akunQ, sidik: buang });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, DELETE");
      return res.status(405).json({ galat: "Metode tidak didukung." });
    }

    // --- pemegang akun: daftarkan perangkat ---
    var b = req.body || {};
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }

    var akun = bersih(b.akun, 64).toLowerCase();
    var verifikasi = bersih(b.verifikasi, 80);
    var sidik = bersih(b.sidik, 80);

    if (!akun || !verifikasi || !sidik) {
      return res.status(400).json({ galat: "Data tidak lengkap." });
    }
    // Bukti kepemilikan akun: hanya yang tahu sandinya bisa menghitung ini.
    var hash = hashAkun(akunSah[akun]);
    if (!hash || !samaAman(verifikasi, hash)) {
      return res.status(401).json({ galat: "Akun tidak dikenali." });
    }

    var sekarang = Date.now();
    var baru = await redis(["HSETNX", kunci(akun), sidik, String(sekarang)]);

    if (baru === 1) {
      var jumlah = await redis(["HLEN", kunci(akun)]);
      if (jumlah > MAKS) {
        // Batalkan pendaftaran yang barusan; slotnya sudah penuh.
        await redis(["HDEL", kunci(akun), sidik]);
        return res.status(403).json({
          status: "penuh",
          maks: MAKS,
          galat: "Akun ini sudah dipakai di " + MAKS + " perangkat."
        });
      }
      return res.status(200).json({ status: "terdaftar", maks: MAKS, slot: jumlah });
    }

    // Perangkat lama: perbarui waktu terakhir dipakai.
    await redis(["HSET", kunci(akun), sidik, String(sekarang)]);
    var total = await redis(["HLEN", kunci(akun)]);
    return res.status(200).json({ status: "dikenali", maks: MAKS, slot: total });

  } catch (err) {
    // Jangan sampai gangguan KV mengunci pembeli yang sah.
    return res.status(200).json({ mati: true, catatan: String(err.message || err) });
  }
};
