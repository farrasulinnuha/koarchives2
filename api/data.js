/*
 * /api/data  —  otak server untuk Arsip Koas.
 *
 * Semua yang penting hidup di sini, bukan di browser:
 *   - daftar akun beserta perannya
 *   - isi arsip (entri, stase, teks situs, tema)
 *   - data pribadi tiap akun (tracker IPK, skor kuis, latar)
 *
 * Akibatnya: buka di laptop mana pun isinya sama, konten berbayar benar-benar
 * tidak dikirim ke yang belum login, menambah akun tidak perlu menerbitkan
 * ulang situs, dan memperbarui berkas situs TIDAK menyentuh data sama sekali.
 *
 * Variabel lingkungan (Vercel > Settings > Environment Variables):
 *   KV_REST_API_URL     wajib \  dari integrasi Upstash Redis
 *   KV_REST_API_TOKEN   wajib /
 *   PEMILIK_AWAL        wajib sekali di awal, bentuk "pengguna:sandi".
 *                       Dipakai hanya kalau belum ada akun sama sekali.
 *                       Hapus variabelnya setelah akun pemilik terbentuk.
 *
 * Peran:
 *   pemilik      atur situs, kelola akun, terbitkan, hapus
 *   kontributor  kirim entri, menunggu persetujuan pemilik
 *   pengakses    hanya membaca
 *
 * Tingkat akses: "penuh" (semua materi) atau "publik" (hanya materi gratis).
 */

var crypto = require("crypto");

var URL_KV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
var TOKEN_KV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
var PEMILIK_AWAL = process.env.PEMILIK_AWAL || "";

var UMUR_SESI = 60 * 60 * 24 * 30; // 30 hari
var PUTARAN = 210000;

/* ---------------------------------------------------------------- Redis */

async function redis(perintah) {
  var r = await fetch(URL_KV, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN_KV, "Content-Type": "application/json" },
    body: JSON.stringify(perintah)
  });
  if (!r.ok) throw new Error("Penyimpanan menjawab " + r.status);
  var j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function ambil(kunci, bawaan) {
  var v = await redis(["GET", kunci]);
  if (v === null || v === undefined) return bawaan;
  try { return JSON.parse(v); } catch (e) { return bawaan; }
}
async function simpan(kunci, nilai) {
  return redis(["SET", kunci, JSON.stringify(nilai)]);
}

/* ------------------------------------------------------------ Kata sandi */

function acakHex(n) { return crypto.randomBytes(n).toString("hex"); }

function olahSandi(sandi, garamHex) {
  return crypto.pbkdf2Sync(String(sandi), Buffer.from(garamHex, "hex"),
    PUTARAN, 32, "sha256").toString("hex");
}

function samaAman(a, b) {
  var ba = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalPengguna(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64);
}

/* --------------------------------------------------------------- Akun */

async function daftarPengguna() { return ambil("akun:daftar", []); }

async function bacaAkun(pengguna) {
  if (!pengguna) return null;
  return ambil("akun:" + pengguna, null);
}

function akunAman(a) {
  if (!a) return null;
  return {
    pengguna: a.pengguna, nama: a.nama, peran: a.peran,
    tingkat: a.tingkat, exp: a.exp || "", aktif: a.aktif !== false,
    ai: a.ai === true, dibuat: a.dibuat || ""
  };
}

async function tulisAkun(a) {
  await simpan("akun:" + a.pengguna, a);
  var daftar = await daftarPengguna();
  if (daftar.indexOf(a.pengguna) === -1) {
    daftar.push(a.pengguna);
    await simpan("akun:daftar", daftar);
  }
}

/* Akun pemilik pertama dibuat dari PEMILIK_AWAL, hanya bila belum ada akun. */
async function siapkanPemilik() {
  var daftar = await daftarPengguna();
  if (daftar.length) return null;
  if (!PEMILIK_AWAL || PEMILIK_AWAL.indexOf(":") === -1) return null;

  var potong = PEMILIK_AWAL.indexOf(":");
  var pengguna = normalPengguna(PEMILIK_AWAL.slice(0, potong));
  var sandi = PEMILIK_AWAL.slice(potong + 1);
  if (pengguna.length < 3 || sandi.length < 6) return null;

  var garam = acakHex(16);
  var akun = {
    pengguna: pengguna, nama: pengguna, peran: "pemilik", tingkat: "penuh",
    garam: garam, hash: olahSandi(sandi, garam),
    exp: "", aktif: true, ai: true, dibuat: new Date().toISOString().slice(0, 10)
  };
  await tulisAkun(akun);
  return akun;
}

/* --------------------------------------------------------------- Sesi */

async function buatSesi(pengguna) {
  var token = acakHex(32);
  await redis(["SET", "sesi:" + token, pengguna, "EX", String(UMUR_SESI)]);
  return token;
}

async function akunDariToken(token) {
  if (!token || typeof token !== "string" || token.length !== 64) return null;
  var pengguna = await redis(["GET", "sesi:" + token]);
  if (!pengguna) return null;
  var a = await bacaAkun(pengguna);
  if (!a || a.aktif === false) return null;
  if (a.exp && a.exp < new Date().toISOString().slice(0, 10)) return null;
  // Perpanjang selama masih dipakai.
  await redis(["EXPIRE", "sesi:" + token, String(UMUR_SESI)]);
  return a;
}

/* -------------------------------------------------------------- Arsip */

async function bacaArsip() {
  return {
    entri: await ambil("arsip:entri", []),
    stase: await ambil("arsip:stase", []),
    staseUbah: await ambil("arsip:staseUbah", []),
    staseGambar: await ambil("arsip:staseGambar", {}),
    teks: await ambil("arsip:teks", {}),
    ikon: await ambil("arsip:ikon", ""),
    tema: await ambil("arsip:tema", null),
    versi: await ambil("arsip:versi", 0)
  };
}

/* Yang dikirim ke klien disaring di server. Materi terbatas tidak pernah
   meninggalkan server untuk akun yang tidak berhak. */
function saringUntuk(arsip, akun) {
  var peran = akun ? akun.peran : "";
  var tingkat = akun ? akun.tingkat : "publik";
  var semua = arsip.entri || [];
  var terlihat;

  if (peran === "pemilik") {
    terlihat = semua;
  } else if (peran === "kontributor") {
    terlihat = semua.filter(function (e) {
      return e.status === "terbit" || e.penulis === akun.pengguna;
    });
  } else {
    terlihat = semua.filter(function (e) { return e.status === "terbit"; });
  }

  if (peran !== "pemilik" && tingkat !== "penuh") {
    terlihat = terlihat.filter(function (e) { return e.akses === "publik"; });
  }
  return Object.assign({}, arsip, { entri: terlihat });
}

function bersihEntri(e, akun) {
  var soal = Array.isArray(e.soal) ? e.soal.filter(function (s) {
    return s && typeof s.q === "string" && Array.isArray(s.opsi) && s.opsi.length >= 2;
  }).map(function (s) {
    var j = Number(s.jawaban);
    return {
      q: String(s.q), opsi: s.opsi.map(String),
      jawaban: (j >= 0 && j < s.opsi.length) ? j : 0,
      penjelasan: String(s.penjelasan || "")
    };
  }) : [];

  var tipe = ["materi", "outline", "kuis", "catatan"].indexOf(e.tipe) !== -1
    ? e.tipe : (soal.length ? "kuis" : "materi");

  return {
    id: String(e.id || ("e-" + acakHex(8))),
    stase: String(e.stase || "ipd"),
    tipe: tipe,
    akses: e.akses === "publik" ? "publik" : "terbatas",
    judul: String(e.judul || "").slice(0, 300),
    tanggal: String(e.tanggal || new Date().toISOString().slice(0, 10)),
    tag: Array.isArray(e.tag) ? e.tag.map(String).slice(0, 20) : [],
    sumber: String(e.sumber || "").slice(0, 500),
    isi: String(e.isi || ""),
    soal: soal,
    // Status dan penulis ditentukan server, bukan klien. Tanpa ini seorang
    // kontributor bisa mengaku menulis atas nama orang lain, sekaligus
    // menyembunyikan kirimannya sendiri dari daftarnya.
    status: akun.peran === "pemilik" ? (e.status === "menunggu" ? "menunggu" : "terbit") : "menunggu",
    penulis: akun.peran === "pemilik" ? (e.penulis || akun.pengguna) : akun.pengguna,
    catatanTinjau: String(e.catatanTinjau || "")
  };
}

/* --------------------------------------------------------------- Handler */

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ galat: "Metode tidak didukung." });
  }
  if (!URL_KV || !TOKEN_KV) {
    return res.status(200).json({ mati: true, catatan: "Penyimpanan belum disetel." });
  }

  var b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  var aksi = String(b.aksi || "");

  try {
    await siapkanPemilik();

    /* ---- masuk ---- */
    if (aksi === "masuk") {
      var pengguna = normalPengguna(b.pengguna);
      var a = await bacaAkun(pengguna);
      // Tetap hitung hash walau akun tidak ada, supaya lamanya jawaban
      // tidak membocorkan nama pengguna mana yang terdaftar.
      var garam = (a && a.garam) || acakHex(16);
      var coba = olahSandi(String(b.sandi || ""), garam);
      if (!a || !samaAman(coba, a.hash)) {
        return res.status(401).json({ galat: "Nama pengguna atau sandi salah." });
      }
      if (a.aktif === false) return res.status(403).json({ galat: "Akun ini dinonaktifkan." });
      if (a.exp && a.exp < new Date().toISOString().slice(0, 10)) {
        return res.status(403).json({ galat: "Akun ini sudah lewat masa berlaku." });
      }
      var token = await buatSesi(a.pengguna);
      var arsip = await bacaArsip();
      return res.status(200).json({
        token: token, akun: akunAman(a),
        arsip: saringUntuk(arsip, a),
        pribadi: await ambil("pribadi:" + a.pengguna, null)
      });
    }

    /* ---- semua aksi di bawah butuh token ---- */
    var akun = await akunDariToken(b.token);

    /* ---- muat (tanpa token = tamu, hanya materi publik) ---- */
    if (aksi === "muat") {
      var arsipSemua = await bacaArsip();
      return res.status(200).json({
        akun: akun ? akunAman(akun) : null,
        arsip: saringUntuk(arsipSemua, akun),
        pribadi: akun ? await ambil("pribadi:" + akun.pengguna, null) : null,
        adaAkun: (await daftarPengguna()).length > 0
      });
    }

    if (!akun) return res.status(401).json({ galat: "Sesi tidak berlaku, masuk lagi." });

    /* ---- keluar ---- */
    if (aksi === "keluar") {
      await redis(["DEL", "sesi:" + b.token]);
      return res.status(200).json({ status: "keluar" });
    }

    /* ---- data pribadi (tracker IPK, skor kuis, latar) ---- */
    if (aksi === "pribadiSimpan") {
      await simpan("pribadi:" + akun.pengguna, b.pribadi || {});
      return res.status(200).json({ status: "tersimpan" });
    }

    /* ---- ganti sandi sendiri ---- */
    if (aksi === "gantiSandi") {
      var lamaOk = samaAman(olahSandi(String(b.lama || ""), akun.garam), akun.hash);
      if (!lamaOk) return res.status(403).json({ galat: "Sandi lama tidak cocok." });
      if (String(b.baru || "").length < 6) return res.status(400).json({ galat: "Sandi baru minimal 6 karakter." });
      akun.garam = acakHex(16);
      akun.hash = olahSandi(String(b.baru), akun.garam);
      await tulisAkun(akun);
      return res.status(200).json({ status: "diganti" });
    }

    /* ---- simpan entri (pemilik & kontributor) ---- */
    if (aksi === "entriSimpan") {
      if (akun.peran !== "pemilik" && akun.peran !== "kontributor") {
        return res.status(403).json({ galat: "Akun ini hanya boleh membaca." });
      }
      var arsipA = await bacaArsip();
      var masuk = Array.isArray(b.entri) ? b.entri : [b.entri];
      var daftarEntri = arsipA.entri.slice();
      var jumlahBaru = 0, jumlahUbah = 0;

      masuk.forEach(function (mentah) {
        if (!mentah || !mentah.judul) return;
        var e = bersihEntri(mentah, akun);
        var idx = -1;
        for (var i = 0; i < daftarEntri.length; i++) {
          if (daftarEntri[i].id === e.id) { idx = i; break; }
        }
        if (idx >= 0) {
          // Kontributor hanya boleh menyunting tulisannya sendiri.
          if (akun.peran !== "pemilik" && daftarEntri[idx].penulis !== akun.pengguna) return;
          e.penulis = daftarEntri[idx].penulis;
          daftarEntri[idx] = e;
          jumlahUbah++;
        } else {
          daftarEntri.push(e);
          jumlahBaru++;
        }
      });

      await simpan("arsip:entri", daftarEntri);
      await simpan("arsip:versi", (arsipA.versi || 0) + 1);
      return res.status(200).json({
        status: "tersimpan", baru: jumlahBaru, diubah: jumlahUbah,
        arsip: saringUntuk(await bacaArsip(), akun)
      });
    }

    /* ---- hapus entri (pemilik) ---- */
    if (aksi === "entriHapus") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik yang boleh menghapus." });
      var arsipH = await bacaArsip();
      var sisa = arsipH.entri.filter(function (e) { return e.id !== b.id; });
      await simpan("arsip:entri", sisa);
      await simpan("arsip:versi", (arsipH.versi || 0) + 1);
      return res.status(200).json({ status: "dihapus", arsip: saringUntuk(await bacaArsip(), akun) });
    }

    /* ---- tinjau kiriman kontributor (pemilik) ---- */
    if (aksi === "entriTinjau") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik yang boleh meninjau." });
      var arsipT = await bacaArsip();
      arsipT.entri.forEach(function (e) {
        if (e.id !== b.id) return;
        if (b.terima) { e.status = "terbit"; e.catatanTinjau = ""; }
        else { e.status = "dikembalikan"; e.catatanTinjau = String(b.catatan || ""); }
      });
      await simpan("arsip:entri", arsipT.entri);
      await simpan("arsip:versi", (arsipT.versi || 0) + 1);
      return res.status(200).json({ status: "ditinjau", arsip: saringUntuk(await bacaArsip(), akun) });
    }

    /* ---- pengaturan situs (pemilik) ---- */
    if (aksi === "aturSimpan") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      if (b.teks) await simpan("arsip:teks", b.teks);
      if (b.tema) await simpan("arsip:tema", b.tema);
      if (b.stase) await simpan("arsip:stase", b.stase);
      if (b.staseUbah) await simpan("arsip:staseUbah", b.staseUbah);
      if (b.staseGambar) await simpan("arsip:staseGambar", b.staseGambar);
      if (typeof b.ikon === "string") await simpan("arsip:ikon", b.ikon);
      return res.status(200).json({ status: "tersimpan", arsip: saringUntuk(await bacaArsip(), akun) });
    }

    /* ---- kelola akun (pemilik) ---- */
    if (aksi === "akunDaftar") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var nama = await daftarPengguna();
      var semua = [];
      for (var i = 0; i < nama.length; i++) {
        var x = await bacaAkun(nama[i]);
        if (x) semua.push(akunAman(x));
      }
      return res.status(200).json({ akun: semua });
    }

    if (aksi === "akunSimpan") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var p = normalPengguna(b.pengguna);
      if (p.length < 3) return res.status(400).json({ galat: "Nama pengguna minimal 3 karakter." });

      var lama = await bacaAkun(p);
      var baru = lama || {
        pengguna: p, garam: acakHex(16), hash: "",
        dibuat: new Date().toISOString().slice(0, 10)
      };
      baru.nama = String(b.nama || p).slice(0, 120);
      baru.peran = ["pemilik", "kontributor", "pengakses"].indexOf(b.peran) !== -1 ? b.peran : "pengakses";
      baru.tingkat = b.tingkat === "publik" ? "publik" : "penuh";
      baru.exp = String(b.exp || "");
      baru.aktif = b.aktif !== false;
      baru.ai = b.ai === true;

      if (b.sandi) {
        if (String(b.sandi).length < 6) return res.status(400).json({ galat: "Sandi minimal 6 karakter." });
        baru.garam = acakHex(16);
        baru.hash = olahSandi(String(b.sandi), baru.garam);
      }
      if (!baru.hash) return res.status(400).json({ galat: "Akun baru wajib diberi sandi." });

      // Jangan sampai pemilik terakhir menurunkan dirinya sendiri dan
      // situsnya jadi tidak bisa dikelola siapa pun.
      if (lama && lama.peran === "pemilik" && baru.peran !== "pemilik") {
        var daftarP = await daftarPengguna();
        var jumlahPemilik = 0;
        for (var k = 0; k < daftarP.length; k++) {
          var cek = await bacaAkun(daftarP[k]);
          if (cek && cek.peran === "pemilik" && cek.aktif !== false) jumlahPemilik++;
        }
        if (jumlahPemilik <= 1) {
          return res.status(400).json({ galat: "Ini satu-satunya akun pemilik yang aktif." });
        }
      }

      await tulisAkun(baru);
      return res.status(200).json({ status: "tersimpan", akun: akunAman(baru) });
    }

    if (aksi === "akunHapus") {
      if (akun.peran !== "pemilik") return res.status(403).json({ galat: "Hanya pemilik." });
      var target = normalPengguna(b.pengguna);
      if (target === akun.pengguna) return res.status(400).json({ galat: "Tidak bisa menghapus akunmu sendiri." });
      await redis(["DEL", "akun:" + target]);
      await redis(["DEL", "pribadi:" + target]);
      var sisaAkun = (await daftarPengguna()).filter(function (n) { return n !== target; });
      await simpan("akun:daftar", sisaAkun);
      return res.status(200).json({ status: "dihapus" });
    }

    return res.status(400).json({ galat: "Aksi tidak dikenal." });

  } catch (err) {
    return res.status(500).json({ galat: String((err && err.message) || err) });
  }
};
