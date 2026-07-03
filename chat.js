// ============================================================
// --- 1. KHỞI TẠO BIẾN & SỰ KIỆN CHÍNH ---
// ============================================================
const chat = document.getElementById('chat');

let isChatLoaded = false;

async function loadChatData() {
    toggleLoading(true, "Đang kết nối...");
    try {
        setupRealtimeSubscription();
        await fetchMessages();
        initInfiniteScroll();
    } catch (error) {
        console.error("Lỗi tải chat:", error);
        showToast("Không thể kết nối server!");
    } finally {
        toggleLoading(false);
        document.dispatchEvent(new Event('chat:ready'));
    }
}


// ============================================================
// --- 2. UI HELPERS ---
// ============================================================
function createBoxShadows(count, maxX, maxY) {
    let shadows = [];
    for (let i = 0; i < count; i++) {
        const x = Math.floor(Math.random() * maxX);
        const y = Math.floor(Math.random() * maxY);
        shadows.push(`${x}px ${y}px #FFF`);
    }
    return shadows.join(', ');
}

const toastEl = document.getElementById('toast-container');
const loadEl = document.getElementById('loading-overlay');
const loadTextEl = document.getElementById('loading-text');
const cancelBtn = document.getElementById('cancel-btn');
const dragOverlay = document.getElementById('drag-overlay');

function showToast(msg) {
    if (toastEl) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        setTimeout(() => toastEl.classList.remove('show'), 2000);
    }
}

function toggleLoading(show, message = "Loading...") {
    if (!loadEl) return;
    if (show) {
        if (loadTextEl) loadTextEl.textContent = message;
        loadEl.classList.add('active');
    } else {
        loadEl.classList.remove('active');
        currentAbortController = null;
    }
}

// ============================================================
// --- 3. CONFIG & SUPABASE ---
// ============================================================
const SUPABASE_URL = 'https://hnvyjvscusmypuhmjthv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhudnlqdnNjdXNteXB1aG1qdGh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU2NDI5OTYsImV4cCI6MjA4MTIxODk5Nn0.EVJGD4WwWGdQJ5adYSOG7Tx5pAP3zOTXzSZdrXwBCGk';
// Hostname trực tiếp cho storage, hiệu năng tốt hơn khi upload file lớn qua TUS
const SUPABASE_PROJECT_ID = 'hnvyjvscusmypuhmjthv';
const SUPABASE_STORAGE_HOST = `https://${SUPABASE_PROJECT_ID}.storage.supabase.co`;
const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentAbortController = null;
let isUploadCancelled = false;

// --- Pagination state ---
const PAGE_SIZE = 50;
let oldestLoadedTimestamp = null; // dùng làm con trỏ để load thêm tin nhắn cũ hơn
let hasMoreOlderMessages = true;
let isLoadingOlderMessages = false;
const renderedMessageIds = new Set(); // tránh render trùng khi infinite scroll + realtime đan xen

function getFileIconSVG(fileName) {
    const ext = fileName ? fileName.split('.').pop().toLowerCase() : '';
    let iconName = 'default';
    const iconMap = {
        'html': 'html', 'css': 'css', 'js': 'js', 'json': 'json', 'xml': 'xml',
        'doc': 'doc', 'docx': 'doc', 'txt': 'txt', 'pdf': 'pdf',
        'xls': 'xlsx', 'xlsx': 'xlsx', 'csv': 'csv',
        'ppt': 'pptx', 'pptx': 'pptx',
        'zip': 'zip', 'rar': 'rar', '7z': '7z', 'apk': 'apk', 'exe': 'exe',
        'jpg': 'jpg', 'jpeg': 'jpeg', 'heic': 'heic', 'png': 'png', 'gif': 'gif',
        'webp': 'webp', 'avif': 'avif', 'svg': 'svg', 'mp4': 'mp4', 'mov': 'mov',
        'mp3': 'mp3', 'wav': 'wav', 'm4a': 'm4a'
    };
    if (iconMap.hasOwnProperty(ext)) iconName = iconMap[ext];
    return `<img src="assets/svg/${iconName}.svg" class="svg-icon" alt="${ext}" loading="lazy">`;
}

// Không còn dùng trong luồng chính (TUS upload luôn trả về 1 URL), giữ lại để dự phòng
function isJsonString(str) {
    try {
        const o = JSON.parse(str);
        if (o && typeof o === "object" && Array.isArray(o)) return o;
    } catch (e) { }
    return false;
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function truncateFileName(name, maxLength = 20) {
    if (!name) return '';
    if (name.length <= maxLength) return name;
    const ext = name.slice(-4);
    const namePart = name.slice(0, maxLength);
    return `${namePart}...${ext}`;
}

function escapeHtml(t) { return t ? t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ""; }

// Giới hạn kích thước cạnh dài nhất của ảnh/video thumbnail (px) và chất lượng nén JPEG.
const THUMB_MAX_SIZE = 480;
const THUMB_QUALITY = 0.7;

// Tính kích thước resize giữ nguyên tỉ lệ, không phóng to nếu ảnh gốc đã nhỏ hơn maxSize.
function fitThumbDimensions(w, h, maxSize) {
    if (!w || !h) return { width: maxSize, height: maxSize };
    if (w <= maxSize && h <= maxSize) return { width: w, height: h };
    const ratio = w > h ? maxSize / w : maxSize / h;
    return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

// Xác định định dạng output cho thumbnail: các định dạng có khả năng chứa kênh alpha
// (PNG, WebP, GIF, AVIF) sẽ được encode lại thành WebP (giữ trong suốt) thay vì JPEG
// (JPEG không hỗ trợ alpha, trình duyệt sẽ tự tô đen phần trong suốt khi encode).
const ALPHA_CAPABLE_EXTS = ['png', 'webp', 'gif', 'avif'];
function getThumbOutputFormat(file) {
    const type = (file.type || '').toLowerCase();
    const ext = file.name ? file.name.split('.').pop().toLowerCase() : '';
    const isAlphaCapable = ALPHA_CAPABLE_EXTS.includes(ext) ||
        ['png', 'webp', 'gif', 'avif'].some(f => type.includes(f));
    return isAlphaCapable ? { mime: 'image/webp', ext: 'webp' } : { mime: 'image/jpeg', ext: 'jpg' };
}

// Resize 1 file ảnh (client-side, dùng Canvas) thành 1 Blob nhỏ để dùng làm thumbnail.
// Với ảnh PNG/WebP/GIF/AVIF, giữ nguyên kênh alpha bằng cách encode ra WebP thay vì JPEG.
// Lưu ý: 1 số định dạng (vd HEIC) trình duyệt không tự decode được vào thẻ <img>, hàm sẽ
// reject và luồng upload sẽ tự fallback sang không có thumbnail (ảnh gốc vẫn hiển thị bình thường).
function resizeImageToBlob(file, maxSize = THUMB_MAX_SIZE, quality = THUMB_QUALITY) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            try {
                const { width, height } = fitThumbDimensions(img.naturalWidth, img.naturalHeight, maxSize);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                // Không tô nền: giữ nguyên vùng trong suốt (canvas mặc định đã transparent)
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);

                const { mime, ext } = getThumbOutputFormat(file);
                canvas.toBlob((blob) => {
                    if (blob) { resolve({ blob, mime, ext }); return; }
                    // Fallback: trình duyệt cũ chưa hỗ trợ encode WebP -> thử lại bằng PNG (lossless, vẫn giữ alpha)
                    if (mime === 'image/webp') {
                        canvas.toBlob((pngBlob) => {
                            pngBlob ? resolve({ blob: pngBlob, mime: 'image/png', ext: 'png' }) : reject(new Error('toBlob thất bại'));
                        }, 'image/png');
                    } else {
                        reject(new Error('toBlob thất bại'));
                    }
                }, mime, quality);
            } catch (e) { reject(e); }
        };
        img.onerror = (e) => { URL.revokeObjectURL(objectUrl); reject(e); };
        img.src = objectUrl;
    });
}

// Trích 1 khung hình (frame) đầu của video (client-side, dùng thẻ <video> ẩn + Canvas)
// làm ảnh poster/thumbnail, thay vì phải tải/giải mã nguyên video để lấy khung hình đầu.
function generateVideoPosterBlob(file, maxSize = THUMB_MAX_SIZE, quality = THUMB_QUALITY) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.src = objectUrl;

        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(objectUrl);
            fn(arg);
        };

        video.addEventListener('loadedmetadata', () => {
            // Seek tới 1 khung hình nhỏ ở đầu video (né khung hình đen/trống ở giây thứ 0
            // mà một số video hay gặp phải).
            const seekTime = Math.min(0.3, (video.duration || 1) / 4);
            try { video.currentTime = seekTime; } catch (e) { finish(reject, e); }
        });

        video.addEventListener('seeked', () => {
            try {
                const { width, height } = fitThumbDimensions(video.videoWidth, video.videoHeight, maxSize);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(video, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob) { finish(resolve, { blob, mime: 'image/jpeg', ext: 'jpg' }); }
                    else { finish(reject, new Error('toBlob thất bại')); }
                }, 'image/jpeg', quality);
            } catch (e) { finish(reject, e); }
        });

        video.addEventListener('error', (e) => finish(reject, e));

        // An toàn: nếu video quá nặng/chậm load metadata thì bỏ qua sau 8s, không chặn upload chính
        setTimeout(() => finish(reject, new Error('Timeout tạo poster video')), 8000);
    });
}

// Upload 1 Blob thumbnail (đã resize nhỏ) lên cùng bucket 'uploads', trả về public URL.
// Dùng upload thường (không cần TUS resumable) vì thumbnail luôn rất nhẹ (vài chục-vài trăm KB).
// thumbResult: { blob, mime, ext } — mime/ext quyết định bởi getThumbOutputFormat (webp/png cho ảnh có alpha).
async function uploadThumbnailBlob(thumbResult, originalFileName) {
    const { blob, mime, ext } = thumbResult;
    const cleanBase = (originalFileName || 'file')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.[^/.]+$/, ''); // bỏ phần đuôi file gốc
    const objectName = `thumb_${Date.now()}_${cleanBase}.${ext}`;

    const { error } = await _supabase.storage.from('uploads').upload(objectName, blob, {
        contentType: mime,
        upsert: false,
        cacheControl: '3600',
    });
    if (error) {
        console.error('Lỗi upload thumbnail:', error);
        return null;
    }
    const { data } = _supabase.storage.from('uploads').getPublicUrl(objectName);
    return data.publicUrl;
}


// ============================================================
// --- 4. CORE: FETCH, RENDER & SCROLL ---
// ============================================================

function setupRealtimeSubscription() {
    _supabase.channel('public:messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
            appendMessage(payload.new);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
            removeMessageFromDOM(payload.old.id);
        })
        .subscribe();
}

// Load lần đầu (hoặc khi không còn dữ liệu): chỉ kéo PAGE_SIZE tin nhắn mới nhất
async function fetchMessages() {
    const { data, error } = await _supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

    if (error) return;

    const items = (data || []).reverse(); // đảo lại thành thứ tự cũ -> mới để render đúng chiều
    if (items.length > 0) {
        oldestLoadedTimestamp = items[0].created_at;
    }
    hasMoreOlderMessages = (data || []).length === PAGE_SIZE;

    await renderInitialList(items);
}

// Cuộn lên đỉnh: kéo thêm 1 trang tin nhắn cũ hơn mốc đang có
async function fetchOlderMessages() {
    if (isLoadingOlderMessages || !hasMoreOlderMessages || !oldestLoadedTimestamp) return;
    isLoadingOlderMessages = true;

    const listDiv = document.getElementById('messageList');
    const topLoader = document.getElementById('top-loader');
    if (topLoader) topLoader.classList.add('active');

    const { data, error } = await _supabase
        .from('messages')
        .select('*')
        .lt('created_at', oldestLoadedTimestamp)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

    isLoadingOlderMessages = false;
    if (topLoader) topLoader.classList.remove('active');
    if (error) return;

    const items = (data || []).reverse();
    hasMoreOlderMessages = (data || []).length === PAGE_SIZE;
    if (items.length === 0) return;

    oldestLoadedTimestamp = items[0].created_at;

    // Giữ nguyên vị trí cuộn của người dùng khi chèn tin nhắn cũ hơn ở phía trên
    const prevScrollHeight = listDiv.scrollHeight;
    prependMessages(items);
    listDiv.scrollTop = listDiv.scrollHeight - prevScrollHeight;
}

// Số tin nhắn tối đa giữ trong DOM cùng lúc (để tránh phình RAM trên trang public chạy lâu)
const MAX_DOM_MESSAGES = 100;

const IMAGE_EXTS = ['jpg', 'jpeg', 'heic', 'png', 'gif', 'webp', 'avif'];
const VIDEO_EXTS = ['mp4', 'mov'];

// SVG icon dùng cho 2 nút hành động khi hover
const ICON_TRASH = `<svg viewBox="0 0 24 24"><path d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1zm-3 6h12l-1 12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 9zm3 2v8h1v-8H9zm3 0v8h1v-8h-1zm3 0v8h1v-8h-1z" fill="#fff"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" fill="#fff"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM13 4h-2v8H7l5 5 5-5h-4V4z" fill="#fff"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="26" height="26"><path d="M8 5v14l11-7z" fill="#fff"/></svg>`;

// Thay thế hàm buildMessageNode cũ
function buildMessageNode(item) {
    let contentHTML = "";
    let clickAttr = ""; // chỉ gán onclick cho ảnh/video (mở lightbox xem full màn hình)
    const safeFileName = (item.file_name || '').replace(/'/g, "\\'");
    const safeRawData = (item.file_url || '').replace(/'/g, "&apos;").replace(/"/g, "&quot;");
    const displayFileName = truncateFileName(item.file_name);

    let isImage = false;
    let isVideo = false;
    const safeThumbData = (item.thumbnail_url || '').replace(/'/g, "&apos;").replace(/"/g, "&quot;");

    if (item.type === 'text') {
        const renderedMarkdown = typeof marked !== 'undefined' ? marked.parse(item.content) : escapeHtml(item.content);
        contentHTML = `<div class="text-content markdown-body" style="word-break: break-word;">${renderedMarkdown}</div>`;
    } else {
        const ext = item.file_name ? item.file_name.split('.').pop().toLowerCase() : '';
        isImage = IMAGE_EXTS.includes(ext);
        isVideo = VIDEO_EXTS.includes(ext);

        if (isImage) {
            // Ưu tiên dùng thumbnail đã được resize nhỏ ngay lúc upload (tạo bằng Canvas ở client).
            // Nếu tin nhắn cũ chưa có thumbnail_url (upload trước khi có tính năng này) thì mới
            // dùng tạm ảnh gốc; nếu ảnh thumbnail load lỗi (vd. bị xóa) cũng tự fallback về ảnh gốc.
            const thumbSrc = item.thumbnail_url || item.file_url;
            const safeThumbSrc = (thumbSrc || '').replace(/'/g, "&apos;").replace(/"/g, "&quot;");
            contentHTML = `<img src="${safeThumbSrc}" data-fallback-src="${safeRawData}" class="chat-image" loading="lazy" decoding="async" onerror="if(this.src!==this.dataset.fallbackSrc){this.onerror=null;this.src=this.dataset.fallbackSrc;}">`;
        } else if (isVideo) {
            // Không render thẻ <video src="..."> trong danh sách chat (tránh trình duyệt tự
            // động tải/prefetch video full quality). Nếu đã có poster thumbnail (tạo lúc upload
            // bằng cách trích 1 khung hình của video ra Canvas) thì hiển thị làm ảnh nền; video
            // full quality thật sự chỉ được nạp khi mở Lightbox.
            const posterStyle = item.thumbnail_url ? ` style="background-image:url('${safeThumbData}')"` : '';
            const posterClass = item.thumbnail_url ? ' has-poster' : '';
            contentHTML = `
                <div class="chat-video-thumb${posterClass}"${posterStyle}>
                    <div class="video-play-icon">${ICON_PLAY}</div>
                </div>`;
        } else {
            contentHTML = `
                <div class="chat-file">
                    <div class="file-icon">${getFileIconSVG(item.file_name)}</div>
                    <div class="file-info">
                        <span class="file-name" title="${escapeHtml(item.file_name)}">${escapeHtml(displayFileName)}</span>
                        <span class="file-size">${item.file_size}</span>
                    </div>
                </div>`;
        }

        if (isImage || isVideo) {
            clickAttr = `onclick="handleBoxClick(this.parentElement, '${item.type}', '${safeRawData}', '${safeFileName}')"`;
        }
    }

    // Nút thứ 2 (tròn): với tin nhắn text -> Copy; với file/ảnh/video -> Tải xuống bản gốc full quality
    const secondaryIcon = item.type === 'text' ? ICON_COPY : ICON_DOWNLOAD;
    const secondaryTitle = item.type === 'text' ? 'Sao chép' : 'Tải xuống';
    const secondaryAction = item.type === 'text'
        ? `handleCopy(this.closest('.message-row').querySelector('.message-box'))`
        : `handleDownload('${safeRawData}', '${safeFileName}')`;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'message-box-wrapper'; // Đổi class bọc ngoài cùng thành wrapper
    msgDiv.dataset.id = item.id;
    // Cấu trúc mới: wrapper -> grid-inner -> message-row -> (message-box, message-actions)
    // message-actions chỉ hiện ra khi hover vào message-row (gồm 2 nút tròn xếp cột: Xóa & Copy/Tải xuống)
    msgDiv.innerHTML = `
        <div class="message-grid-inner">
            <div class="message-row">
                <div class="message-box">
                    <div class="msg-click-area" ${clickAttr}>
                        ${contentHTML}
                    </div>
                </div>
                <div class="message-actions">
                    <button class="action-btn secondary-action-btn" title="${secondaryTitle}" onclick="${secondaryAction}">${secondaryIcon}</button>
                    <button class="action-btn delete-action-btn" title="Xóa" onclick="deleteItem(${item.id}, '${item.type}', '${safeFileName}', '${safeRawData}', '${safeThumbData}')">${ICON_TRASH}</button>
                </div>
            </div>
        </div>
    `;
    return msgDiv;
}

// Preload 1 URL ảnh rời (dùng cho poster video, vốn không phải thẻ <img> mà là CSS
// background-image nên không tự có sự kiện onload/complete để chờ như <img> thường).
function preloadImageURL(url) {
    return new Promise(resolve => {
        if (!url) { resolve(); return; }
        const img = new Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = url;
    });
}

// Chờ TOÀN BỘ media thật sự sẵn sàng trong 1 container trước khi đo/dùng kích thước của nó,
// gồm cả 2 loại: <img class="chat-image"> (ảnh) VÀ .chat-video-thumb.has-poster (video, ảnh
// poster nằm ở CSS background-image chứ không phải thẻ <img> nên trước đây bị bỏ sót hoàn
// toàn -> không được chờ tí nào). timeoutMs mặc định 800ms để không chặn render danh sách quá
// lâu; những chỗ cần chính xác tuyệt đối (swap placeholder khi upload xong, auto-scroll cuối
// cùng) nên truyền timeoutMs lớn hơn hẳn để không bị "chờ hụt" rồi gây giật/thiếu scroll.
function waitForMediaReady(container, timeoutMs = 800) {
    const promises = [];

    container.querySelectorAll('img.chat-image').forEach(img => {
        // FIX LAZY LOAD BUG: Ép tải bằng Image() ảo qua preloadImageURL
        // để nhét sẵn ảnh vào cache hệ thống trước khi gắn vào DOM.
        if (img.src) promises.push(preloadImageURL(img.src));
    });

    container.querySelectorAll('.chat-video-thumb.has-poster').forEach(el => {
        const match = /url\((['"]?)(.*?)\1\)/.exec(el.style.backgroundImage || '');
        if (match && match[2]) promises.push(preloadImageURL(match[2]));
    });

    if (promises.length === 0) return Promise.resolve();
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, timeoutMs));
    return Promise.race([Promise.all(promises), timeoutPromise]);
}

// Giữ lại tên cũ để tương thích ngược, giờ chỉ là alias gọi thẳng vào bản đầy đủ ở trên.
function waitForImages(container) {
    return waitForMediaReady(container, 800);
}

// Cuộn mượt xuống đáy danh sách chat, rồi "chốt" lại đúng đáy 1 lần nữa (không animation) sau
// khi hiệu ứng cuộn mượt kết thúc. Lý do cần chốt thêm lần 2: target của scrollTo({smooth}) chỉ
// được tính DUY NHẤT 1 LẦN tại thời điểm gọi (dựa trên scrollHeight lúc đó); nếu ngay trong lúc
// đang cuộn mà layout còn dịch chuyển nhẹ (ảnh vừa preload xong nhưng trình duyệt còn đang decode/
// paint, font kịp load...) thì kết quả cuối cùng có thể dừng lại TRƯỚC đáy thật vài chục px. Chốt
// lại lần 2 sau khi cuộn xong đảm bảo luôn chạm đáy chính xác 100%.
function scrollChatToBottom() {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;

    const snapToBottom = () => { listDiv.scrollTop = listDiv.scrollHeight; };

    listDiv.scrollTo({ top: listDiv.scrollHeight, behavior: 'smooth' });

    if ('onscrollend' in window) {
        listDiv.addEventListener('scrollend', snapToBottom, { once: true });
    } else {
        // Fallback cho trình duyệt chưa hỗ trợ sự kiện scrollend: ước lượng đủ thời gian
        // để hiệu ứng smooth-scroll (mặc định trình duyệt) chạy xong rồi mới chốt lại.
        setTimeout(snapToBottom, 450);
    }
}

// Render lần đầu (load chat hoặc reload toàn bộ danh sách hiện có)
async function renderInitialList(items) {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;

    listDiv.innerHTML = "";
    renderedMessageIds.clear();

    items.forEach(item => {
        const node = buildMessageNode(item);
        listDiv.appendChild(node);
        renderedMessageIds.add(item.id);
    });

    await waitForMediaReady(listDiv, 6000);   // thêm await
    listDiv.scrollTop = listDiv.scrollHeight;
}

// Thêm 1 tin nhắn mới vào cuối danh sách (realtime INSERT), có animation trượt lên + fade in.
// Các tin nhắn cũ được đẩy lên mượt mà nhờ CSS transition trên chính flow layout (flex column),
// không cần animate riêng từng tin cũ.
function appendMessage(item) {
    if (!item || renderedMessageIds.has(item.id)) return;

    // Chặn trùng lặp với file đang tự upload
    if (item.type !== 'text' && item.file_url) {
        for (const [tempId, entry] of pendingUploads.entries()) {
            if (entry.fileUrl === item.file_url) {
                entry.realItem = item;
                renderedMessageIds.add(item.id);
                return;
            }
        }
    }

    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;

    const node = buildMessageNode(item);

    // 1. Gắn class message-enter (chiều cao = 0, vô hình) trước khi đưa vào DOM
    node.classList.add('message-enter');
    listDiv.appendChild(node);

    // Cuộn sơ bộ để đảm bảo vùng chứa node luôn bám đáy
    listDiv.scrollTop = listDiv.scrollHeight;

    // 2. Đóng gói logic animation bung chiều cao
    const startAnimation = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                node.classList.add('message-enter-active');
            });
        });

        // Vòng lặp đồng bộ thanh cuộn bám đáy khi Grid đang nở ra
        const scrollInterval = setInterval(() => {
            listDiv.scrollTop = listDiv.scrollHeight;
        }, 16);

        const onTransitionEnd = (e) => {
            if (e.propertyName === 'grid-template-rows') {
                clearInterval(scrollInterval);
                node.removeEventListener('transitionend', onTransitionEnd);
                node.classList.remove('message-enter', 'message-enter-active');
                listDiv.scrollTop = listDiv.scrollHeight;
            }
        };
        node.addEventListener('transitionend', onTransitionEnd);

        trimOldMessagesFromDOM();
    };

    // 3. FIX LỖI GIẬT HEIGHT ĐỘT NGỘT:
    // Nếu tin nhắn có ảnh/video, bắt buộc chờ tải xong media vào cache hệ thống.
    // Khi ảnh đã có kích thước thực tế, CSS Grid 1fr mới tính toán chuẩn xác được.
    if (item.type !== 'text') {
        waitForMediaReady(node, 6000).then(startAnimation);
    } else {
        // Tin nhắn chữ (kích thước cố định sẵn) thì chạy animation ngay
        startAnimation();
    }
}

// Chèn 1 trang tin nhắn cũ hơn vào đầu danh sách (infinite scroll lên trên)
function prependMessages(items) {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        if (renderedMessageIds.has(item.id)) return;
        const node = buildMessageNode(item);
        fragment.appendChild(node);
        renderedMessageIds.add(item.id);
    });
    listDiv.insertBefore(fragment, listDiv.firstChild);
}

// Nếu DOM đang giữ quá nhiều tin nhắn, xóa bớt những tin cũ nhất ở đầu danh sách.
// Chỉ chạy khi người dùng đang ở gần đáy (đang theo dõi tin mới), để không xóa mất
// nội dung ngay dưới mắt người dùng nếu họ đang cuộn xem lịch sử cũ.
function trimOldMessagesFromDOM() {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;
    const isNearBottom = (listDiv.scrollHeight - listDiv.scrollTop - listDiv.clientHeight) < 150;
    if (!isNearBottom) return;

    let excess = listDiv.children.length - MAX_DOM_MESSAGES;
    while (excess > 0 && listDiv.firstChild) {
        const idAttr = listDiv.firstChild.dataset ? listDiv.firstChild.dataset.id : null;
        if (idAttr) renderedMessageIds.delete(Number(idAttr));
        listDiv.removeChild(listDiv.firstChild);
        excess--;
    }
    // Vì đã cắt bớt phía trên, cần cho phép load lại tin cũ hơn nếu người dùng cuộn lên
    hasMoreOlderMessages = true;
    if (listDiv.firstChild && listDiv.firstChild.dataset.id) {
        // cập nhật lại mốc oldestLoadedTimestamp dựa trên item đầu tiên còn lại trong DOM
        // (sẽ được set chính xác hơn khi cần qua fetchOlderMessages)
    }
}

function removeMessageFromDOM(id) {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;
    const wrapper = listDiv.querySelector(`.message-box-wrapper[data-id="${id}"]`);
    if (wrapper) {
        // Thêm class exit để kích hoạt đồng thời grid-template-rows: 0fr và padding-bottom: 0
        wrapper.classList.add('message-exit');

        // Đợi hiệu ứng trượt hoàn tất mượt mà rồi mới xóa khỏi DOM để tránh bị khựng nhảy hình
        const onTransitionEnd = (e) => {
            if (e.propertyName === 'grid-template-rows') {
                wrapper.removeEventListener('transitionend', onTransitionEnd);
                wrapper.remove();
            }
        };

        wrapper.addEventListener('transitionend', onTransitionEnd);

        // Fallback dọn dẹp an toàn sau 550ms nếu transition bị lỗi ẩn
        setTimeout(() => { if (wrapper.parentNode) wrapper.remove(); }, 550);
    }
    renderedMessageIds.delete(id);
}

// Lắng nghe sự kiện cuộn để tự động load thêm tin nhắn cũ khi gần chạm đỉnh
function initInfiniteScroll() {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;
    listDiv.addEventListener('scroll', () => {
        if (listDiv.scrollTop < 80) {
            fetchOlderMessages();
        }
    });
}


// ============================================================
// --- 5. ACTION HANDLERS ---
// ============================================================

// SỬA HÀM COPY: Copy dưới dạng HTML để dán vào Word có định dạng
window.handleCopy = async (element) => {
    const textDiv = element.querySelector('.text-content');
    if (!textDiv) return;

    const htmlContent = textDiv.innerHTML;
    const plainText = textDiv.innerText;

    try {
        // Tạo Blob cho HTML và Plain Text
        const blobHtml = new Blob([htmlContent], { type: "text/html" });
        const blobText = new Blob([plainText], { type: "text/plain" });

        // Sử dụng Clipboard API hiện đại
        const data = [new ClipboardItem({
            "text/html": blobHtml,
            "text/plain": blobText
        })];

        await navigator.clipboard.write(data);

        showToast("Đã sao chép định dạng!");
        element.style.backgroundColor = "#2196F3";
        setTimeout(() => element.style.backgroundColor = "", 300);
    } catch (err) {
        console.error("Lỗi copy định dạng:", err);
        // Fallback về copy text thuần nếu trình duyệt không hỗ trợ ClipboardItem HTML
        navigator.clipboard.writeText(plainText).then(() => {
            showToast("Đã sao chép text!");
        });
    }
}

// Drag Drop
initDragAndDrop();
if (cancelBtn) {
    cancelBtn.onclick = () => {
        isUploadCancelled = true;
        if (currentAbortController) {
            currentAbortController.abort();
            showToast("Đã hủy tác vụ");
        }
        toggleLoading(false);
    };
}

function initDragAndDrop() {
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        dragOverlay.classList.add('active');
    });
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragOverlay.classList.remove('active');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            processUploadQueue(e.dataTransfer.files);
        }
    });
    dragOverlay.addEventListener('dragleave', (e) => {
        if (e.target === dragOverlay) dragOverlay.classList.remove('active');
    });
    dragOverlay.onclick = () => dragOverlay.classList.remove('active');
}

// Xử lý dán ảnh
const textInputEl = document.getElementById('textInput');
if (textInputEl) {
    textInputEl.addEventListener('paste', (e) => {
        const items = (e.clipboardData || window.clipboardData).items;
        const filesToUpload = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image") !== -1) {
                const blob = items[i].getAsFile();
                if (blob) {
                    const ext = blob.type.split('/')[1] || 'png';
                    const newFileName = `pasted_image_${Date.now()}.${ext}`;
                    const file = new File([blob], newFileName, { type: blob.type });
                    filesToUpload.push(file);
                }
            }
        }
        if (filesToUpload.length > 0) {
            e.preventDefault();
            processUploadQueue(filesToUpload);
        }
    });
}

// Download — dùng tham số ?download= của Supabase Storage để server trả về header
// Content-Disposition: attachment. Thuộc tính `download` trên thẻ <a> bị trình duyệt
// BỎ QUA khi link là cross-origin (khác domain với trang web), nên trước đây bấm tải
// ảnh/video lại bị mở ra tab mới thay vì tải xuống. Thêm param này ép server luôn trả
// về file đính kèm (attachment) bất kể loại nội dung gì.
window.handleDownload = (fileUrl, fileName) => {
    if (!fileUrl) return;
    let downloadUrl = fileUrl;
    try {
        const urlObj = new URL(fileUrl);
        urlObj.searchParams.set('download', fileName || '');
        downloadUrl = urlObj.toString();
    } catch (e) { /* nếu URL không hợp lệ để parse thì vẫn thử tải bằng URL gốc */ }

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Giờ chỉ còn được gọi khi click vào ảnh/video (để mở Lightbox xem full màn hình + full quality).
// Việc copy (text) và tải xuống (file/ảnh/video) đã được chuyển hẳn sang 2 nút tròn hiện khi hover.
window.handleBoxClick = (boxElement, type, url, fileName) => {
    if (type === 'text') return;
    const ext = fileName ? fileName.split('.').pop().toLowerCase() : '';
    const isImage = IMAGE_EXTS.includes(ext);
    const isVideo = VIDEO_EXTS.includes(ext);

    if (isImage || isVideo) {
        openLightbox(url, isImage ? 'image' : 'video');
    }
}

// ============================================================
// --- 5b. PENDING UPLOAD PLACEHOLDER (optimistic UI) ---
// Ngay khi người dùng chọn/kéo-thả file, ta chèn 1 node "giữ chỗ" vào cuối danh sách
// NGAY LẬP TỨC (trước khi bất kỳ thao tác upload/network nào chạy). Nhờ vậy nếu 1 tin
// nhắn khác (từ realtime, người khác gửi) đến trong lúc file đang upload, nó sẽ luôn
// được xếp SAU chỗ đã giữ này thay vì chen lên trước. Không còn overlay full-screen hay
// text % nào (mọi thông tin tiến độ được thể hiện hoàn toàn bằng vòng tròn quay dần từ 0 -> 360 độ).
// ============================================================
let pendingUploadCounter = 0;
const pendingUploads = new Map(); // tempId -> { node, blobUrls: string[], cancelled, abort, resolveFn }
// Ghi nhớ RIÊNG các tempId đã bị hủy, tồn tại độc lập với pendingUploads (Map này có thể đã
// bị xóa entry ngay khi hủy) để các bước xử lý bất đồng bộ phía sau (tạo thumbnail, upload TUS...)
// vẫn nhận biết được là đã bị hủy và dừng đúng lúc, không tiếp tục upload ngầm vô ích.
const cancelledUploadIds = new Set();

function createPendingId() {
    pendingUploadCounter += 1;
    return `pending-${Date.now()}-${pendingUploadCounter}`;
}

// Vòng tròn tiến độ dùng SVG <circle> + stroke-dashoffset: khác với 1 spinner xoay vô tận,
// độ dài cung tròn được vẽ ra phản ánh ĐÚNG % byte đã upload thật sự (0% = rỗng, 100% = tròn đầy).
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function progressRingSVG() {
    return `
        <svg viewBox="0 0 40 40">
            <circle class="upload-progress-ring-bg" cx="20" cy="20" r="${RING_RADIUS}"></circle>
            <circle class="upload-progress-ring-bar" cx="20" cy="20" r="${RING_RADIUS}"
                stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"></circle>
        </svg>`;
}

// size (px): kích thước hiển thị của vòng tròn. Nút × luôn được đặt CHÍNH GIỮA vòng tròn (bên trong lỗ tròn).
function buildProgressRingWrap(tempId, size) {
    // Đã chuyển thành SVG sắc nét
    const cancelSvg = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    return `
        <div class="upload-progress-ring-wrap" style="width:${size}px;height:${size}px;">
            ${progressRingSVG()}
            <button type="button" class="upload-cancel-btn" title="Hủy" onclick="cancelPendingUpload('${tempId}')">${cancelSvg}</button>
        </div>`;
}

// Cập nhật độ dài cung tròn theo % thật đã upload (0-100), gọi liên tục trong onProgress của TUS.
function updatePendingProgress(tempId, percent) {
    const entry = pendingUploads.get(tempId);
    if (!entry) return;
    const bar = entry.node.querySelector('.upload-progress-ring-bar');
    if (!bar) return;
    const clamped = Math.max(0, Math.min(100, percent));
    const offset = RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * clamped / 100);
    bar.style.strokeDashoffset = String(offset);
}

function buildPendingNode(file, tempId) {
    const ext = file.name ? file.name.split('.').pop().toLowerCase() : '';
    const isImage = IMAGE_EXTS.includes(ext);
    const isVideo = VIDEO_EXTS.includes(ext);
    const blobUrls = [];

    let contentHTML = "";
    if (isImage) {
        // Trả lại tỷ lệ tự nhiên cho ảnh gốc, không ép khung 260x170 nữa
        const previewUrl = URL.createObjectURL(file);
        blobUrls.push(previewUrl);
        contentHTML = `
            <div class="pending-media-wrap">
                <img src="${previewUrl}" class="chat-image">
                <div class="upload-progress-overlay">${buildProgressRingWrap(tempId, 64)}</div>
            </div>`;
    } else if (isVideo) {
        // Chưa có frame nào ngay lúc này -> hiện skeleton loading, sẽ được thay bằng poster thật
        // (updatePendingVideoPoster) ngay khi trích xong khung hình đầu video.
        contentHTML = `
            <div class="pending-media-wrap">
                <div class="upload-skeleton" data-role="video-skeleton"></div>
                <div class="upload-progress-overlay">${buildProgressRingWrap(tempId, 64)}</div>
            </div>`;
    } else {
        // Trong lúc đang upload: KHÔNG hiện icon loại file, thay bằng hẳn vòng tròn tiến độ 72px
        // chiếm trọn vị trí đó; icon file thật sự chỉ xuất hiện khi tin nhắn chính thức thay thế node này.
        contentHTML = `
            <div class="chat-file pending">
                <div class="file-icon-uploading">${buildProgressRingWrap(tempId, 55)}</div>
                <div class="file-info">
                    <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(truncateFileName(file.name))}</span>
                    <span class="file-size">${formatFileSize(file.size)}</span>
                </div>
            </div>`;
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = 'message-box-wrapper';
    msgDiv.dataset.id = tempId;
    msgDiv.innerHTML = `
        <div class="message-grid-inner">
            <div class="message-row">
                <div class="message-box">
                    <div class="msg-click-area">
                        ${contentHTML}
                    </div>
                </div>
            </div>
        </div>
    `;

    pendingUploads.set(tempId, { node: msgDiv, blobUrls, cancelled: false, abort: null });
    return msgDiv;
}

// Chèn placeholder vào cuối danh sách ngay lập tức (giữ chỗ) + animation trượt lên giống tin nhắn thường.
function appendPendingNode(tempId) {
    const entry = pendingUploads.get(tempId);
    if (!entry) return;
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;

    // Đưa về trạng thái đóng (0fr)
    entry.node.classList.add('message-enter');
    listDiv.appendChild(entry.node);

    // ĐÃ XÓA: listDiv.scrollTop = listDiv.scrollHeight; (Thủ phạm gây giật khung hình)

    const img = entry.node.querySelector('img.chat-image');

    const startAnimation = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                entry.node.classList.add('message-enter-active');
            });
        });

        // Vòng lặp bám đáy trong lúc Grid đang mở rộng
        const scrollInterval = setInterval(() => {
            listDiv.scrollTop = listDiv.scrollHeight;
        }, 16);

        const onTransitionEnd = (e) => {
            if (e.propertyName === 'grid-template-rows') {
                clearInterval(scrollInterval);
                entry.node.removeEventListener('transitionend', onTransitionEnd);
                entry.node.classList.remove('message-enter', 'message-enter-active');
                listDiv.scrollTop = listDiv.scrollHeight;
            }
        };
        entry.node.addEventListener('transitionend', onTransitionEnd);
    };

    if (img && !img.complete) {
        img.onload = startAnimation;
        img.onerror = startAnimation;
    } else {
        startAnimation();
    }
}

// Video: khi đã trích xong khung hình đầu (thumbResult.blob), thay skeleton bằng poster thật,
// spinner vẫn tiếp tục xoay vì file gốc có thể vẫn đang upload.
function updatePendingVideoPoster(tempId, blob) {
    const entry = pendingUploads.get(tempId);
    if (!entry) return;
    const skeleton = entry.node.querySelector('[data-role="video-skeleton"]');
    if (!skeleton) return;
    const url = URL.createObjectURL(blob);
    entry.blobUrls.push(url);
    skeleton.classList.remove('upload-skeleton');
    skeleton.removeAttribute('data-role');
    skeleton.classList.add('pending-video-poster');
    skeleton.style.backgroundImage = `url('${url}')`;
}

// Upload xong: thay hẳn node placeholder bằng node tin nhắn thật (dùng chung buildMessageNode
// như tin nhắn nhận qua realtime), rồi dọn các blob URL tạm để tránh rò rỉ bộ nhớ.
// QUAN TRỌNG: ảnh/video thật (URL trên server) được PRELOAD xong hoàn toàn trước khi swap vào DOM.
// Nếu không preload, thẻ <img> mới (chưa có width/height cố định) sẽ tạm thời co gần về 0px ngay
// lúc thay thế skeleton -> các tin nhắn khác bị đẩy dồn lấp chỗ trống -> rồi ảnh mới mới "bụp" hiện
// ra khi tải xong, gây cảm giác giật lag qua 3 giai đoạn. Preload trước giúp browser đã có sẵn ảnh
// trong cache nên khi swap vào, ảnh hiện ra tức thời đúng kích thước cuối cùng, không co giãn.
async function resolvePendingUpload(tempId, item) {
    const entry = pendingUploads.get(tempId);
    if (!entry) return;

    renderedMessageIds.add(item.id);
    const realNode = buildMessageNode(item);

    // Ảnh bây giờ chắc chắn 100% được tải vào cache trước khi lệnh đi tiếp
    await waitForMediaReady(realNode, 6000);

    if (entry.node.parentNode) {
        const oldBox = entry.node.querySelector('.message-box');
        const newBox = realNode.querySelector('.message-box');

        // Khóa khung dựa trên bounding client thực tế
        if (oldBox && newBox) {
            const rect = oldBox.getBoundingClientRect();
            newBox.style.minHeight = rect.height + 'px';
            newBox.style.minWidth = rect.width + 'px';
        }

        entry.node.parentNode.replaceChild(realNode, entry.node);

        // Trả lại độ co giãn đàn hồi cho message box
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (newBox) {
                    newBox.style.minHeight = '';
                    newBox.style.minWidth = '';
                }
            });
        });
    }

    entry.blobUrls.forEach(u => URL.revokeObjectURL(u));
    pendingUploads.delete(tempId);
}

// Upload lỗi/bị hủy: gỡ placeholder khỏi DOM + dọn blob URL tạm.
function rejectPendingUpload(tempId) {
    const entry = pendingUploads.get(tempId);
    if (!entry) return;
    entry.blobUrls.forEach(u => URL.revokeObjectURL(u));
    if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    pendingUploads.delete(tempId);
}

// Cho phép hủy TỪNG file đang/sắp upload (nút × trên overlay), không ảnh hưởng các file khác trong hàng đợi.
window.cancelPendingUpload = (tempId) => {
    cancelledUploadIds.add(tempId);
    const entry = pendingUploads.get(tempId);
    if (!entry) return;
    entry.cancelled = true;

    // Dừng network transfer nếu file đang thật sự upload qua TUS. LƯU Ý QUAN TRỌNG: gọi
    // abort() của tus-js-client KHÔNG đảm bảo sẽ tự trigger callback onError, nên KHÔNG thể
    // chỉ dựa vào đó để dọn UI (đây chính là nguyên nhân gây lỗi placeholder "kẹt" lại trên
    // màn hình mãi tới khi tải lại trang) -> phải tự dọn dẹp DOM + giải phóng hàng đợi ngay dưới đây.
    if (entry.abort) entry.abort();

    // Luôn gỡ node khỏi DOM ngay lập tức, không chờ bất kỳ callback bất định nào của thư viện upload
    rejectPendingUpload(tempId);

    // Nếu file này đang giữa chừng 1 tác vụ upload TUS (Promise của uploadSingleFile chưa resolve),
    // giải phóng nó ngay để vòng lặp hàng đợi (processUploadQueue) không bị treo mãi, có thể
    // tiếp tục upload file kế tiếp trong hàng đợi.
    if (entry.resolveFn) entry.resolveFn();
};

// Upload & Send
window.handleInputFiles = (inputElement) => {
    if (inputElement.files && inputElement.files.length > 0) processUploadQueue(inputElement.files);
}

async function processUploadQueue(files) {
    // Giữ chỗ cho TẤT CẢ file ngay lập tức, trước khi upload tuần tự bất kỳ file nào,
    // để không có tin nhắn nào (kể cả từ người khác) chen được vào trước các file này.
    const queue = Array.from(files).map(file => {
        const tempId = createPendingId();
        buildPendingNode(file, tempId);
        appendPendingNode(tempId);
        return { file, tempId };
    });

    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = "";

    for (let i = 0; i < queue.length; i++) {
        const { file, tempId } = queue[i];
        const entry = pendingUploads.get(tempId);
        if (!entry || entry.cancelled) continue; // đã bị hủy trước khi tới lượt
        await uploadSingleFile(file, tempId);
    }
}

// Upload qua TUS resumable protocol: nếu mạng đứt giữa chừng, tus-js-client sẽ tự
// resume đúng phần % đã tải khi `retryDelays` còn lượt thử và mạng có lại,
// thay vì phải băm file và upload lại từ đầu như cách cũ.
async function uploadSingleFile(file, tempId) {
    // Bước 1: nếu là ảnh/video thì tạo trước 1 thumbnail nhỏ (Canvas, client-side) và upload
    // riêng lên storage. Bước này không dùng TUS vì thumbnail luôn rất nhẹ; nếu lỗi (vd. định
    // dạng ảnh trình duyệt không decode được) thì bỏ qua, không chặn luồng upload file chính.
    const ext = file.name.split('.').pop().toLowerCase();
    const isImage = IMAGE_EXTS.includes(ext);
    const isVideo = VIDEO_EXTS.includes(ext);
    let thumbnailUrl = null;

    if (isImage || isVideo) {
        try {
            const thumbResult = isImage ? await resizeImageToBlob(file) : await generateVideoPosterBlob(file);
            if (cancelledUploadIds.has(tempId)) { rejectPendingUpload(tempId); return; }
            if (isVideo) updatePendingVideoPoster(tempId, thumbResult.blob);
            thumbnailUrl = await uploadThumbnailBlob(thumbResult, file.name);
        } catch (e) {
            console.warn('Không tạo được thumbnail, sẽ hiển thị tạm ảnh/video gốc:', e);
        }
    }

    if (cancelledUploadIds.has(tempId)) { rejectPendingUpload(tempId); return; }

    // Bước 2: upload file gốc (full quality) qua TUS resumable protocol như cũ.
    return new Promise((resolve) => {
        const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const objectName = `${Date.now()}_${cleanName}`;

        if (typeof tus === 'undefined') {
            showToast("Thiếu thư viện tus-js-client!");
            rejectPendingUpload(tempId);
            resolve();
            return;
        }

        const upload = new tus.Upload(file, {
            endpoint: `${SUPABASE_STORAGE_HOST}/storage/v1/upload/resumable`,
            retryDelays: [0, 3000, 5000, 10000, 20000],
            headers: {
                // App hoàn toàn public/anonymous: dùng anon key làm credential,
                // RLS policy của bucket 'uploads' cần cho phép insert ở role anon.
                authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
                'x-upsert': 'false',
            },
            uploadDataDuringCreation: true,
            removeFingerprintOnSuccess: true,
            metadata: {
                bucketName: 'uploads',
                objectName: objectName,
                contentType: file.type || 'application/octet-stream',
                cacheControl: '3600',
            },
            chunkSize: 6 * 1024 * 1024, // bắt buộc 6MB theo giới hạn hiện tại của Supabase TUS endpoint
            onError: function (error) {
                // Nếu đã bị người dùng hủy chủ động, đây chỉ là hệ quả của abort() (không phải lỗi
                // mạng thật) -> im lặng bỏ qua, UI đã được dọn sạch ngay từ lúc bấm hủy.
                if (cancelledUploadIds.has(tempId)) { resolve(); return; }
                console.error('Lỗi upload TUS:', error);
                showToast("Lỗi upload: " + file.name);
                rejectPendingUpload(tempId);
                resolve();
            },
            onProgress: function (bytesUploaded, bytesTotal) {
                // Vòng tròn quay từ 0 -> 360 độ theo ĐÚNG % byte đã upload thật, không phải spinner vô tận.
                const percent = bytesTotal ? (bytesUploaded / bytesTotal) * 100 : 0;
                updatePendingProgress(tempId, percent);
            },
            onSuccess: async function () {
                if (cancelledUploadIds.has(tempId)) { resolve(); return; }
                const { data } = _supabase.storage.from('uploads').getPublicUrl(objectName);

                // Cắm cờ URL vào entry để hàm appendMessage có thể nhận diện và chặn Realtime
                const entry = pendingUploads.get(tempId);
                if (entry) entry.fileUrl = data.publicUrl;

                const { data: inserted, error } = await _supabase.from('messages').insert([{
                    type: 'file',
                    file_name: file.name,
                    file_size: formatFileSize(file.size),
                    file_url: data.publicUrl,
                    thumbnail_url: thumbnailUrl
                }]).select().single();

                // Lấy data từ HTTP hoặc từ cục Realtime đã chạy nhanh hơn
                const finalItem = inserted || (entry && entry.realItem);

                if (error && !finalItem) {
                    console.error('Lỗi lưu tin nhắn:', error);
                    showToast("Lỗi lưu tin nhắn: " + file.name);
                    rejectPendingUpload(tempId);
                } else {
                    resolvePendingUpload(tempId, finalItem);
                }
                resolve();
            },
        });

        // Gắn abort riêng cho placeholder này để nút × có thể hủy đúng file đang upload, đồng thời
        // lưu lại resolve() của chính Promise này để cancelPendingUpload có thể tự giải phóng hàng
        // đợi ngay lập tức (không chờ tus-js-client tự gọi lại onError, vì abort() không đảm bảo
        // trigger callback đó).
        const entry = pendingUploads.get(tempId);
        if (entry) {
            entry.abort = () => upload.abort();
            entry.resolveFn = resolve;
        }
        currentAbortController = { abort: () => upload.abort() };

        upload.findPreviousUploads().then(function (previousUploads) {
            if (previousUploads.length) {
                upload.resumeFromPreviousUpload(previousUploads[0]);
            }
            upload.start();
        });
    });
}

async function sendText() {
    const input = document.getElementById('textInput');
    const val = input.value.trim();
    if (!val) return;
    input.value = "";
    await _supabase.from('messages').insert([{ content: val, type: 'text' }]);
    input.style.height = 'auto';
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function handleEnter(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendText();
    }
}

window.deleteItem = async (id, type, fileName, rawUrlData, thumbnailUrlData) => {
    // 1. Xóa ngay lập tức khỏi giao diện web (UI) trước
    removeMessageFromDOM(id);

    // 2. Chạy ngầm việc xóa trên Server (Database & Storage) sau
    try {
        const deleteMsgPromise = _supabase.from('messages').delete().eq('id', id);
        const storageObjectsToRemove = [];

        if (type === 'file' && rawUrlData && rawUrlData.startsWith('http')) {
            storageObjectsToRemove.push(rawUrlData.split('/').pop());
        }
        // Dọn luôn file thumbnail (nếu có) để không để lại rác trong storage
        if (thumbnailUrlData && thumbnailUrlData.startsWith('http')) {
            storageObjectsToRemove.push(thumbnailUrlData.split('/').pop());
        }

        if (storageObjectsToRemove.length > 0) {
            await Promise.all([
                deleteMsgPromise,
                _supabase.storage.from('uploads').remove(storageObjectsToRemove)
            ]);
        } else {
            await deleteMsgPromise;
        }
    } catch (error) {
        console.error("Lỗi khi xóa tin nhắn trên server:", error);
        showToast("Không thể xóa tin nhắn trên hệ thống!");
        // Note: Nếu muốn an toàn tuyệt đối, bạn có thể fetch lại danh sách 
        // hoặc chèn lại node nếu server báo lỗi, nhưng với app chat public thì chạy ngầm như trên là mượt nhất.
    }
}

// --- LIGHTBOX CONTROLLER ---
function openLightbox(url, mediaType) {
    const lightbox = document.getElementById('media-lightbox');
    const contentContainer = lightbox.querySelector('.lightbox-content');

    // Xóa nội dung cũ trước đó
    contentContainer.innerHTML = '';

    if (mediaType === 'image') {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Fullscreen Preview';
        contentContainer.appendChild(img);
    } else if (mediaType === 'video') {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true; // Tự động phát khi phóng to công việc tiện lợi hơn
        contentContainer.appendChild(video);
    }

    lightbox.classList.add('active');

    // Ngăn chặn sự kiện click lan ra ngoài làm đóng chat widget chat
    lightbox.addEventListener('click', (e) => e.stopPropagation());
}

function closeLightbox(event) {
    if (event) event.stopPropagation();
    const lightbox = document.getElementById('media-lightbox');
    const contentContainer = lightbox.querySelector('.lightbox-content');

    lightbox.classList.remove('active');

    // Tạm dừng video nếu đang phát trước khi xóa node để tránh lỗi ngầm âm thanh
    const video = contentContainer.querySelector('video');
    if (video) video.pause();

    // Dọn dẹp DOM sau khi animation ẩn kết thúc
    setTimeout(() => {
        if (!lightbox.classList.contains('active')) {
            contentContainer.innerHTML = '';
        }
    }, 300);
}

// Hỗ trợ bấm phím ESC trên bàn phím để tắt nhanh ảnh/video full màn hình
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const lightbox = document.getElementById('media-lightbox');
        if (lightbox && lightbox.classList.contains('active')) {
            closeLightbox();
        }
    }
});

// ============================================================
// --- KHỞI CHẠY CHAT ---
// #chat giờ luôn là giao diện full page nên tự động tải ngay khi vào trang,
// không cần chờ click mở "bong bóng" chat nữa. Đặt ở cuối file để đảm bảo
// mọi const/hàm phía trên (loadEl, toastEl, dragOverlay...) đã được khai báo.
// ============================================================
if (!isChatLoaded) {
    isChatLoaded = true;
    loadChatData();
}














































(() => {
    const COLORS = ["#a8d8f0", "#c3e8ff", "#b0deff", "#d6f0ff", "#7ec8e3", "#e0f4ff", "#90cce8", "#bce8fa"];
    const VARIANTS = ["v-a", "v-b", "v-c", "v-d"];
    const FLAKE_COUNT = 80;

    // =====================================================================
    // MẢNG CHỨA CÁC SVG BÔNG TUYẾT (Bạn có thể thêm/bớt thoải mái ở đây)
    // Dùng currentColor để SVG tự nhận màu ngẫu nhiên từ mảng COLORS
    // Dùng .map() bên trong chuỗi để rút gọn các nhánh lặp lại (đỡ dài dòng)
    // Nhưng bạn hoàn toàn có thể paste một mã <svg>...</svg> tĩnh copy từ Figma vào đây.
    // =====================================================================
    const SVG_FLAKES = [
        // Mẫu 0: Cơ bản, 6 nhánh đơn giản
        `<svg viewBox="0 0 445 513" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M234.427 160.68a29 29 0 0 0 2.415-.917c6.372-1.04 10.498-3.335 15.593-8.41l-2.173-6.278c1.221-.992 2.59-1.749 4.077-2.324 1.736-.676 3.686-1.014 5.686-1.274 2.007-.254 4.043-.458 5.918-.914 1.907-.405 3.594-1.16 5.329-1.836 1.731-.684 3.467-1.357 5.144-2.128 1.668-.783 3.262-1.682 4.724-2.787 2.92-2.217 5.515-4.941 7.842-8.091a40 40 0 0 0 3.235-5.126c.974-1.867 1.88-3.852 2.539-6.213l-1.006-1.58c-2.42-.399-4.602-.419-6.707-.325a40 40 0 0 0-6.011.765c-3.838.777-7.405 1.981-10.647 3.691-1.619.857-3.108 1.921-4.521 3.102-1.406 1.194-2.754 2.484-4.101 3.764-1.345 1.289-2.742 2.496-3.919 4.055-1.203 1.507-2.251 3.267-3.325 4.976-1.081 1.705-2.212 3.329-3.559 4.617-1.345 1.29-2.834 2.355-4.551 3.057-.979.428-2.075.676-3.218.846l-13.821-4.055-.017-6.828c1.995-.646 4.112-1.609 6.092-3.065 6.648-4.889 9.219-13.395 9.219-13.395s-8.201-.577-14.846 4.313c-.171.124-.33.262-.496.392l-.022-9.221c3.45-.39 7.537-1.355 11.226-3.546l11.362-.153-9.81-.861a23 23 0 0 0 2.688-2.26l14.143-.235-12.783-1.201a29 29 0 0 0 2.532-3.371l18.289-3.307-17.312 1.688c2.214-3.913 14.58-13.469 14.58-13.469s-14.094 5.892-17.703 6.128l5.689-13.071-7.551 13.24a32.3 32.3 0 0 0-5.591 1.137l2.295-14.533-4.038 15.121a24 24 0 0 0-3.882 1.863l1.292-10.353-2.815 11.356a23 23 0 0 0-2.642 2.235l-.073-29.054c2.741-.498 5.837-1.48 8.623-3.369 7.136-4.839 9.509-13.784 9.509-13.784s-9.187-1.097-16.321 3.742c-.659.447-1.262.936-1.841 1.444l-.007-3.261 21.013-20.255-21.047 7.484-.017-7.501c-1.113-5.225-2.246-10.449-3.501-15.674A341 341 0 0 0 221.54 0a342 342 0 0 0-3.992 15.692c-1.228 5.229-2.336 10.459-3.42 15.69l.019 7.976-22.488-7.996 22.869 21.708.371 9.675v1.714c0-1.497-3.22-2.916-5.042-4.108-8.64-5.664-20.141-4.097-20.141-4.097s2.597 10.751 11.244 16.412c4.374 2.867 9.391 3.879 13.324 4.182l.029 20.21a23.7 23.7 0 0 0-3.767-3.395l-2.815-11.356 1.284 10.353a24 24 0 0 0-3.883-1.863l-4.038-15.121 2.295 14.533a32.3 32.3 0 0 0-5.592-1.137l-7.55-13.24 5.689 13.071c-3.607-.236-17.702-6.128-17.702-6.128s12.367 9.556 14.58 13.469l-17.312-1.688 18.288 3.307a29 29 0 0 0 2.533 3.371l-12.786 1.201 14.144.235a23 23 0 0 0 2.687 2.26l-9.808.861 11.36.153c4.122 2.448 8.735 3.363 12.402 3.66l.027 10.703a21 21 0 0 0-2.315-1.987c-6.648-4.89-14.85-4.313-14.85-4.313s2.572 8.506 9.221 13.395c2.616 1.925 5.465 2.994 7.97 3.594l.015 5.739-16.116 4.74c-1.467-.166-2.872-.43-4.1-.969-1.721-.702-3.209-1.766-4.552-3.057-1.346-1.288-2.478-2.911-3.558-4.617-1.077-1.709-2.122-3.469-3.327-4.976-1.175-1.559-2.572-2.766-3.918-4.055-1.35-1.28-2.697-2.57-4.101-3.764-1.415-1.18-2.904-2.245-4.523-3.102-3.242-1.71-6.81-2.914-10.647-3.691a40 40 0 0 0-6.012-.765c-2.106-.094-4.285-.075-6.707.325l-1.005 1.58c.661 2.361 1.563 4.346 2.539 6.213a40 40 0 0 0 3.235 5.126c2.326 3.149 4.922 5.874 7.843 8.091 1.46 1.105 3.055 2.005 4.723 2.787 1.675.77 3.413 1.444 5.144 2.128 1.736.676 3.42 1.431 5.33 1.836 1.876.457 3.912.66 5.915.914 2.001.26 3.952.598 5.687 1.274 1.738.673 3.331 1.572 4.695 2.834.622.548 1.172 1.211 1.69 1.926l-1.045 2.905c2.315 4.031 6.513 7.29 11.081 8.853a28.5 28.5 0 0 0 3.744 1.489l-19.195 9.006 25.337 5.859 1.951 3.917.02 8.656.005 2.166-17.326-4.525 17.338 9.206.007 2.809-15.613-3.901 15.969 8.582v.781l-8.792.467 8.555 7.938c-.008 1.307-.003 2.613-.091 3.92-.063.817-.166 1.634-.166 2.451l-8.149-3.699 8.555 6.543 1.372 6.463c.608 2.611 1.164 5.224 1.816 7.836 1.25 5.224 2.588 10.448 4.168 15.671 1.55-5.23 2.862-10.461 4.087-15.691.637-2.616 1.179-5.231 1.775-7.845l1.343-6.471 8.552-6.661-8.147 3.816c0-.816-.091-1.633-.154-2.45-.076-1.062-.061-2.123-.066-3.185l9.328-8.793-8.986.313v-.096l-.186-.84 17.041-11.547-17.188 6.865-.027-2.497 16.975-11.859-17.007 7.178-.01-2.982-.034-12.641 23.909-1.698zm-88.825 37.261c.178-.852.313-1.7.413-2.547 2.289-6.042 2.362-10.76.515-17.711l-6.523-1.257c-.249-1.553-.219-3.118.026-4.692.283-1.841.963-3.701 1.738-5.563.785-1.863 1.626-3.729 2.167-5.581.604-1.856.792-3.692 1.076-5.534.276-1.841.559-3.681.732-5.519.155-1.835.173-3.665-.054-5.483-.459-3.638-1.522-7.25-3.085-10.839a40 40 0 0 0-2.821-5.363c-1.133-1.779-2.399-3.553-4.115-5.306l-1.868.082c-1.558 1.896-2.666 3.775-3.635 5.646a40 40 0 0 0-2.345 5.589c-1.244 3.712-1.985 7.401-2.125 11.066-.066 1.831.112 3.652.426 5.468.331 1.814.774 3.624 1.207 5.433.445 1.809.791 3.623 1.555 5.419.701 1.798 1.703 3.583 2.645 5.37.936 1.788 1.778 3.58 2.218 5.391.446 1.809.623 3.629.37 5.471-.117 1.059-.449 2.131-.872 3.208l-10.425 9.941-5.922-3.399c.438-2.053.66-4.365.389-6.808-.909-8.204-6.989-14.685-6.989-14.685s-4.601 6.814-3.691 15.016c.023.211.065.415.095.623l-7.999-4.59c1.387-3.18 2.595-7.201 2.542-11.494l5.549-9.917-5.648 8.066a23 23 0 0 0-.615-3.458l6.87-12.366-7.433 10.471a29 29 0 0 0-1.654-3.879l6.281-17.493-7.196 15.836c-2.281-3.872-4.374-19.361-4.374-19.361s-1.945 15.154-3.545 18.396l-8.476-11.463 7.693 13.158a32.5 32.5 0 0 0-1.813 5.413l-11.437-9.255 11.074 11.057a24 24 0 0 0-.326 4.292l-8.322-6.29 8.429 8.113c.117 1.175.331 2.314.612 3.407l-25.197-14.464c.941-2.624 1.637-5.796 1.395-9.153-.625-8.597-7.184-15.126-7.184-15.126s-5.546 7.407-4.919 16.003c.056.794.179 1.563.327 2.317l-2.827-1.623-7.033-28.325-4.043 21.969-6.506-3.734c-5.081-1.65-10.171-3.282-15.322-4.808A348 348 0 0 0 0 128.763a342 342 0 0 0 11.592 11.305c3.918 3.678 7.892 7.252 11.881 10.807l6.917 3.971-18.171 15.477 30.062-8.651 8.391 4.817 1.486.852c-1.958.398-3.964 1.034-5.906 2.014-9.227 4.653-13.533 15.247-13.533 15.247s10.652 3.05 19.879-1.608c4.673-2.354 8.078-6.229 10.305-9.485l17.529 10.062a23.7 23.7 0 0 0-4.82 1.554l-11.238-3.242 9.607 4.06a24 24 0 0 0-3.553 2.432l-15.112-4.064 13.734 5.277a32.6 32.6 0 0 0-3.783 4.275l-15.24-.082 14.167 1.607c-2.008 3.007-14.161 12.268-14.161 12.268s14.459-5.933 18.956-5.891l-10.117 14.148 12.008-14.186a28.6 28.6 0 0 0 4.186-.508l-5.353 11.672 7.277-12.13a23.4 23.4 0 0 0 3.301-1.198l-4.16 8.924 5.814-9.763c4.179-2.345 7.278-5.883 9.368-8.91l9.284 5.33c-.964.263-1.93.595-2.878 1.01-7.557 3.311-11.159 10.704-11.159 10.704s8.651 2.025 16.211-1.29c2.975-1.303 5.327-3.235 7.096-5.103l4.975 2.858-3.951 16.326c-.879 1.187-1.807 2.271-2.889 3.065-1.468 1.139-3.133 1.896-4.923 2.414-1.788.521-3.762.69-5.778.774-2.019.077-4.066.101-5.973.393-1.937.238-3.681.842-5.47 1.364-1.784.531-3.573 1.051-5.309 1.67-1.731.636-3.395 1.393-4.948 2.366-3.104 1.953-5.929 4.441-8.521 7.376a40 40 0 0 0-3.668 4.823c-1.137 1.776-2.207 3.674-3.071 5.97l.864 1.66c2.375.609 4.545.819 6.649.908a40 40 0 0 0 6.057-.237c3.889-.441 7.549-1.328 10.927-2.749 1.69-.712 3.265-1.644 4.776-2.696 1.504-1.066 2.957-2.233 4.415-3.39 1.453-1.166 2.949-2.249 4.254-3.699 1.333-1.395 2.528-3.058 3.749-4.667 1.227-1.602 2.496-3.121 3.949-4.287 1.45-1.171 3.027-2.1 4.8-2.648.787-.266 1.636-.411 2.515-.5l1.993 2.357c4.647.011 9.569-1.996 13.207-5.168a29 29 0 0 0 3.163-2.5l-1.797 21.127 17.741-19.01 4.366.27 7.506 4.31 1.879 1.078-12.582 12.741 16.642-10.41 2.437 1.398-11.271 11.719 15.33-9.388.677.389-3.905 7.698 11.195-3.513c1.129.66 2.284 1.271 3.372 2.002.679.461 1.341.942 2.052 1.348l-7.274 5.2 9.947-4.142 6.283 2.041c2.566.779 5.108 1.604 7.695 2.345 5.151 1.528 10.346 2.982 15.654 4.227-3.755-3.956-7.627-7.709-11.543-11.386-1.948-1.859-3.942-3.639-5.906-5.463l-4.933-4.398-1.493-10.737-.768 8.965c-.708-.408-1.46-.74-2.2-1.092-.958-.464-1.872-1.008-2.79-1.538l-3.09-12.23-4.364 8.179-.082-.048-.68-.503-1.412-20.648-2.61 18.255-2.162-1.254-1.771-20.647-2.284 18.308-2.584-1.484-10.963-6.293 10.483-21.555zm-12.143 95.554a27 27 0 0 0-2.001-1.63c-4.088-5.004-8.136-7.428-15.079-9.304l-4.351 5.023c-1.471-.562-2.809-1.369-4.05-2.371-1.456-1.164-2.722-2.684-3.949-4.287-1.22-1.61-2.416-3.271-3.749-4.667-1.305-1.45-2.802-2.532-4.254-3.698-1.459-1.157-2.91-2.324-4.415-3.391-1.514-1.053-3.09-1.984-4.777-2.697-3.38-1.422-7.037-2.307-10.926-2.748a40 40 0 0 0-6.057-.239c-2.104.091-4.276.301-6.653.91l-.863 1.659c.867 2.295 1.936 4.194 3.071 5.97a40 40 0 0 0 3.67 4.823c2.592 2.933 5.416 5.421 8.518 7.375 1.552.974 3.22 1.731 4.948 2.366 1.738.62 3.528 1.14 5.31 1.669 1.788.522 3.534 1.127 5.469 1.366 1.909.29 3.957.315 5.976.393 2.015.084 3.988.251 5.775.774 1.792.519 3.457 1.276 4.924 2.414.859.633 1.621 1.457 2.34 2.361l3.401 13.998-5.906 3.429c-1.557-1.406-3.449-2.755-5.699-3.741-7.56-3.316-16.214-1.29-16.214-1.29s3.601 7.392 11.158 10.704c.197.085.393.153.588.231l-7.975 4.63c-2.062-2.79-4.94-5.846-8.684-7.949l-5.814-9.762 4.162 8.924a23.5 23.5 0 0 0-3.3-1.198l-7.279-12.13 5.353 11.671a29 29 0 0 0-4.187-.505l-12.008-14.187 10.118 14.148c-4.496.043-18.956-5.891-18.956-5.891s12.153 9.263 14.16 12.268l-14.165 1.608 15.24-.082a32.4 32.4 0 0 0 3.782 4.275l-13.735 5.279 15.115-4.065a24 24 0 0 0 3.554 2.432l-9.609 4.06 11.24-3.242c1.078.486 2.172.869 3.258 1.173l-25.125 14.59c-1.803-2.128-4.2-4.318-7.229-5.784-7.759-3.76-16.69-1.343-16.69-1.343s3.643 8.504 11.4 12.261a19 19 0 0 0 2.168.875l-2.818 1.637-28.049-8.073 17.007 14.486-6.487 3.767c-3.969 3.574-7.927 7.168-11.825 10.866a344 344 0 0 0-11.538 11.36 345 345 0 0 0 15.586-4.387c5.144-1.553 10.227-3.209 15.3-4.885l6.896-4.005 4.32 23.474 7.538-30.359 8.368-4.858 1.481-.862c-.635 1.895-1.085 3.949-1.21 6.123-.582 10.316 6.438 19.341 6.438 19.341s7.968-7.699 8.55-18.017c.295-5.224-1.357-10.111-3.063-13.666l17.476-10.15a24 24 0 0 0-1.063 4.95l-8.427 8.113 8.32-6.292a24 24 0 0 0 .328 4.293l-11.078 11.057 11.44-9.257c.46 1.968 1.113 3.796 1.81 5.413l-7.69 13.158 8.474-11.464c1.602 3.242 3.546 18.396 3.546 18.396s2.092-15.489 4.374-19.361l7.192 15.836-6.278-17.493a28.5 28.5 0 0 0 1.651-3.879l7.433 10.471-6.866-12.366c.283-1.111.494-2.264.611-3.458l5.651 8.066-5.548-9.918c.058-4.791-1.453-9.243-3.03-12.567l9.254-5.376a21 21 0 0 0-.564 2.999c-.912 8.201 3.689 15.016 3.689 15.016s6.081-6.481 6.991-14.685c.36-3.226-.141-6.229-.872-8.696l4.963-2.881 12.161 11.586c.588 1.354 1.063 2.702 1.211 4.034.252 1.842.073 3.662-.372 5.471-.441 1.809-1.282 3.602-2.218 5.389-.942 1.787-1.942 3.573-2.645 5.371-.763 1.796-1.112 3.608-1.553 5.419-.433 1.809-.877 3.618-1.211 5.433-.313 1.815-.49 3.634-.422 5.466.14 3.664.881 7.353 2.125 11.067a40 40 0 0 0 2.342 5.588c.972 1.872 2.08 3.75 3.635 5.645l1.87.083c1.716-1.753 2.982-3.528 4.112-5.306a40 40 0 0 0 2.822-5.364c1.565-3.589 2.626-7.2 3.083-10.837.227-1.819.21-3.649.054-5.486-.171-1.835-.457-3.677-.729-5.517-.283-1.842-.471-3.678-1.076-5.533-.543-1.852-1.384-3.719-2.167-5.582-.775-1.862-1.455-3.72-1.738-5.562-.288-1.842-.307-3.67.107-5.482.163-.814.461-1.622.823-2.428l3.039-.546c2.333-4.021 3.057-9.286 2.127-14.022a29 29 0 0 0-.581-3.989l17.396 12.121-7.594-24.87 2.42-3.646 7.483-4.346 1.874-1.089 4.744 17.267-.696-19.617 2.429-1.411 4.514 15.62-.466-17.97.675-.393 4.716 7.23 2.554-11.451c1.136-.646 2.243-1.342 3.418-1.919.74-.357 1.489-.691 2.195-1.102l.867 8.897 1.387-10.682 4.91-4.422c1.957-1.835 3.943-3.623 5.878-5.492 3.899-3.697 7.754-7.467 11.489-11.444-5.303 1.273-10.491 2.753-15.635 4.304-2.582.756-5.12 1.593-7.682 2.385l-6.276 2.07-10.045-4.075 7.379 5.148c-.706.409-1.368.895-2.043 1.359-.883.598-1.808 1.117-2.728 1.648l-12.138-3.44 4.904 7.868-.084.048-.774.337-18.59-9.102 14.507 11.389-2.167 1.243-18.768-8.788 14.715 11.132-2.579 1.496-10.933 6.347-13.425-19.856zm76.681 58.294c-.828.272-1.628.578-2.414.919-6.374 1.037-10.501 3.332-15.596 8.408l2.174 6.278c-1.218.991-2.589 1.748-4.076 2.323-1.736.676-3.688 1.016-5.686 1.274-2.005.254-4.043.458-5.918.914-1.909.405-3.595 1.16-5.331 1.837-1.73.683-3.466 1.357-5.143 2.125-1.668.784-3.26 1.682-4.724 2.789-2.92 2.216-5.515 4.94-7.843 8.09a40 40 0 0 0-3.234 5.125c-.977 1.87-1.879 3.854-2.539 6.216l1.007 1.578c2.418.398 4.601.42 6.705.325a40 40 0 0 0 6.011-.765c3.839-.779 7.405-1.98 10.647-3.69 1.619-.858 3.107-1.923 4.524-3.102 1.405-1.195 2.75-2.484 4.099-3.763 1.348-1.289 2.743-2.498 3.917-4.056 1.206-1.506 2.251-3.266 3.326-4.977 1.084-1.703 2.213-3.329 3.558-4.614 1.346-1.293 2.834-2.353 4.555-3.058.977-.427 2.073-.675 3.215-.846l13.821 4.055.02 6.828c-1.997.647-4.114 1.609-6.094 3.065-6.648 4.89-9.22 13.396-9.22 13.396s8.202.578 14.847-4.313c.171-.126.33-.263.496-.393l.022 9.222c-3.45.389-7.532 1.355-11.226 3.545l-11.364.154 9.811.858a23.6 23.6 0 0 0-2.689 2.261l-14.141.236 12.782 1.201a29 29 0 0 0-2.53 3.373l-18.289 3.307 17.31-1.688c-2.213 3.913-14.58 13.469-14.58 13.469s14.098-5.893 17.705-6.129l-5.69 13.073 7.547-13.24a32.5 32.5 0 0 0 5.594-1.138l-2.296 14.533 4.038-15.121a24 24 0 0 0 3.883-1.863l-1.292 10.353 2.815-11.355a23 23 0 0 0 2.642-2.235l.073 29.052c-2.742.498-5.84 1.481-8.625 3.371-7.134 4.839-9.507 13.783-9.507 13.783s9.186 1.097 16.317-3.742a19 19 0 0 0 1.843-1.442l.007 3.259-21.009 20.255 21.047-7.484.02 7.502c1.111 5.225 2.243 10.449 3.498 15.674a339 339 0 0 0 4.068 15.67 346 346 0 0 0 3.994-15.69c1.225-5.232 2.334-10.461 3.418-15.692l-.02-7.976 22.488 7.996-22.754-21.709-.256-9.674v-1.713c2.5 1.497 3.105 2.915 4.929 4.108 8.64 5.663 20.08 4.095 20.08 4.095s-2.625-10.749-11.272-16.414c-4.372-2.866-9.404-3.878-13.337-4.18l-.034-20.21a23.8 23.8 0 0 0 3.76 3.395l2.817 11.355-1.289-10.353a24 24 0 0 0 3.884 1.863l4.038 15.121-2.297-14.533a32.7 32.7 0 0 0 5.593 1.138l7.549 13.24-5.688-13.073c3.606.236 17.703 6.129 17.703 6.129s-12.368-9.556-14.58-13.469l17.312 1.688-18.288-3.307a28.6 28.6 0 0 0-2.534-3.373l12.786-1.201-14.143-.234a23 23 0 0 0-2.686-2.262l9.807-.858-11.36-.154c-4.126-2.445-8.735-3.363-12.402-3.659l-.027-10.704a21 21 0 0 0 2.314 1.988c6.648 4.89 14.851 4.313 14.851 4.313s-2.573-8.506-9.224-13.396c-2.615-1.924-5.464-2.993-7.969-3.593l-.01-5.738 16.111-4.74c1.467.166 2.871.43 4.101.968 1.719.704 3.206 1.765 4.551 3.058 1.345 1.286 2.478 2.913 3.559 4.614 1.074 1.711 2.119 3.47 3.325 4.977 1.174 1.559 2.573 2.767 3.918 4.056 1.35 1.279 2.696 2.568 4.102 3.763 1.414 1.179 2.903 2.242 4.521 3.102 3.245 1.71 6.809 2.911 10.647 3.69 1.919.391 3.911.661 6.013.765 2.104.095 4.285.073 6.702-.325l1.008-1.578c-.661-2.362-1.563-4.346-2.539-6.216a40 40 0 0 0-3.233-5.125c-2.327-3.15-4.924-5.874-7.844-8.09-1.462-1.106-3.057-2.005-4.724-2.789-1.677-.768-3.413-1.443-5.144-2.125-1.736-.677-3.421-1.432-5.33-1.837-1.875-.455-3.913-.66-5.916-.913-2.002-.26-3.95-.599-5.688-1.276-1.736-.672-3.33-1.572-4.695-2.833-.62-.55-1.172-1.211-1.689-1.928l1.045-2.905c-2.315-4.03-6.511-7.289-11.077-8.851a28.5 28.5 0 0 0-3.747-1.489l19.197-9.009-25.337-5.857-1.95-3.917-.02-8.657-.005-2.165 17.324 4.525-17.337-9.207-.007-2.809 15.728 3.901-15.853-8.579v-.781l8.677-.467-8.611-7.937c.007-1.307-.027-2.615.061-3.921.061-.818.151-1.634.146-2.451l8.145 3.699-8.557-6.542-1.37-6.464c-.611-2.612-1.172-5.223-1.821-7.837-1.25-5.223-2.586-10.449-4.165-15.67-1.548 5.231-2.862 10.46-4.087 15.691-.64 2.615-1.182 5.231-1.777 7.845l-1.343 6.471-8.552 6.663 8.147-3.818c0 .817.09 1.633.154 2.451.076 1.061.061 2.124.066 3.185l-7.961 8.792 10.349-.311v.095l-1.182.841-17.719 11.545 16.84-6.866-.142 2.498-17.153 11.859 16.856-7.178v2.982l.117 12.64-23.865 1.697zm88.826-37.261a27 27 0 0 0-.41 2.549c-2.292 6.043-2.366 10.762-.518 17.711l6.523 1.256c.249 1.553.217 3.118-.027 4.692-.283 1.842-.964 3.701-1.738 5.563-.786 1.864-1.626 3.729-2.17 5.583-.601 1.854-.789 3.691-1.072 5.532-.276 1.841-.559 3.682-.732 5.518-.151 1.836-.173 3.666.054 5.486.461 3.635 1.521 7.248 3.083 10.838a41 41 0 0 0 2.822 5.362c1.133 1.78 2.4 3.553 4.114 5.308l1.87-.083c1.555-1.896 2.666-3.773 3.633-5.646a40 40 0 0 0 2.346-5.589c1.243-3.712 1.985-7.402 2.126-11.066.066-1.831-.11-3.652-.427-5.467-.332-1.815-.774-3.623-1.208-5.434-.44-1.81-.789-3.622-1.555-5.418-.701-1.798-1.702-3.584-2.644-5.371-.933-1.79-1.777-3.58-2.214-5.389-.449-1.81-.625-3.632-.374-5.471.117-1.061.452-2.133.874-3.207l10.422-9.943 5.925 3.398c-.442 2.052-.664 4.365-.393 6.807.908 8.204 6.99 14.686 6.99 14.686s4.602-6.815 3.689-15.016c-.022-.21-.063-.416-.093-.624l7.998 4.59c-1.387 3.181-2.593 7.202-2.544 11.494l-5.547 9.917 5.65-8.065q.182 1.79.613 3.457l-6.867 12.367 7.431-10.471a29 29 0 0 0 1.655 3.878l-6.282 17.493 7.193-15.836c2.285 3.872 4.378 19.362 4.378 19.362s1.946-15.155 3.545-18.397l8.476 11.465-7.69-13.158a33 33 0 0 0 1.809-5.412l11.441 9.255-11.079-11.057a24 24 0 0 0 .327-4.293l8.323 6.292-8.428-8.113a23 23 0 0 0-.615-3.408l25.198 14.464c-.94 2.624-1.638 5.798-1.391 9.154.62 8.597 7.18 15.124 7.18 15.124s5.547-7.407 4.919-16.002a19 19 0 0 0-.327-2.318l2.827 1.624 7.031 28.326 4.043-21.969 6.509 3.733c5.076 1.652 10.168 3.282 15.32 4.808a344 344 0 0 0 15.608 4.312 343 343 0 0 0-11.592-11.303c-3.919-3.679-7.893-7.252-11.882-10.808l-6.917-3.97 18.171-15.478-30.061 8.65-8.391-4.815-1.487-.853c1.958-.397 3.96-1.033 5.906-2.013 9.226-4.655 13.533-15.247 13.533-15.247s-10.652-3.049-19.88 1.607c-4.67 2.355-8.076 6.23-10.305 9.485l-17.527-10.06a24 24 0 0 0 4.819-1.555l11.24 3.241-9.612-4.059a24 24 0 0 0 3.555-2.432l15.115 4.064-13.735-5.277a32.5 32.5 0 0 0 3.782-4.274l15.242.082-14.167-1.609c2.009-3.008 14.162-12.269 14.162-12.269s-14.46 5.933-18.958 5.892l10.117-14.147-12.005 14.182a29 29 0 0 0-4.189.509l5.354-11.673-7.278 12.131c-1.104.31-2.207.703-3.301 1.199l4.162-8.927-5.818 9.764c-4.177 2.347-7.276 5.881-9.365 8.91l-9.285-5.328a21 21 0 0 0 2.881-1.011c7.556-3.312 11.16-10.702 11.16-10.702s-8.655-2.026-16.213 1.286c-2.976 1.304-5.325 3.236-7.097 5.105l-4.975-2.859 3.95-16.323c.879-1.188 1.812-2.274 2.891-3.068 1.47-1.137 3.132-1.895 4.924-2.413 1.787-.521 3.76-.69 5.776-.774 2.019-.077 4.065-.104 5.972-.394 1.938-.236 3.682-.841 5.471-1.365 1.785-.529 3.574-1.049 5.313-1.67 1.726-.635 3.391-1.391 4.944-2.364 3.106-1.954 5.928-4.441 8.521-7.374a40 40 0 0 0 3.67-4.824c1.135-1.775 2.207-3.676 3.071-5.969l-.864-1.661c-2.376-.608-4.546-.819-6.653-.908a40 40 0 0 0-6.054.237c-3.889.442-7.547 1.328-10.928 2.749-1.689.713-3.264 1.644-4.776 2.697-1.504 1.067-2.956 2.234-4.414 3.391-1.453 1.166-2.949 2.246-4.255 3.698-1.333 1.396-2.529 3.058-3.75 4.668-1.226 1.603-2.495 3.121-3.948 4.287-1.453 1.168-3.025 2.097-4.8 2.647-.786.267-1.636.412-2.515.503l-1.995-2.36c-4.646-.009-9.568 1.996-13.203 5.17a29 29 0 0 0-3.164 2.497l1.797-21.127-17.742 19.013-4.365-.27-7.507-4.311-1.877-1.077 12.58-12.742-16.643 10.411-2.434-1.398 11.27-11.72-15.33 9.389-.679-.389 3.906-7.698-11.194 3.513c-1.13-.66-2.285-1.271-3.374-2.001-.674-.461-1.34-.944-2.051-1.349l7.276-5.198-9.947 4.141-6.286-2.042c-2.563-.78-5.105-1.603-7.693-2.345-5.151-1.53-10.347-2.981-15.654-4.227 3.755 3.958 7.627 7.71 11.543 11.387 1.948 1.859 3.94 3.638 5.906 5.461l4.932 4.398 1.494 10.737.769-8.964c.708.408 1.46.739 2.197 1.09.959.465 1.873 1.008 2.793 1.538l3.105 12.201 4.38-8.211.083.047.667.532 1.399 20.665 2.607-18.247 2.158 1.257 1.77 20.65 2.283-18.308 2.586 1.484 10.964 6.295-10.486 21.555zm12.14-95.554a29 29 0 0 0 2.002 1.631c4.089 5.004 8.14 7.427 15.081 9.303l4.35-5.022c1.47.561 2.808 1.37 4.051 2.371 1.453 1.164 2.722 2.683 3.948 4.286 1.223 1.61 2.417 3.271 3.752 4.668 1.304 1.45 2.801 2.531 4.253 3.698 1.458 1.157 2.908 2.323 4.412 3.391 1.514 1.051 3.088 1.982 4.778 2.696 3.379 1.42 7.039 2.307 10.928 2.748a40 40 0 0 0 6.055.238c2.109-.09 4.277-.3 6.653-.909l.864-1.66c-.864-2.295-1.936-4.194-3.074-5.971a40 40 0 0 0-3.664-4.823c-2.595-2.935-5.42-5.421-8.521-7.374-1.553-.974-3.22-1.731-4.949-2.367-1.738-.62-3.526-1.139-5.313-1.67-1.787-.523-3.533-1.126-5.466-1.363-1.909-.291-3.955-.316-5.974-.394-2.016-.084-3.989-.25-5.776-.772-1.792-.519-3.457-1.277-4.924-2.416-.859-.632-1.621-1.456-2.341-2.359l-3.399-13.998 5.906-3.43c1.558 1.406 3.447 2.756 5.698 3.743 7.561 3.313 16.214 1.288 16.214 1.288s-3.601-7.391-11.16-10.702c-.193-.084-.391-.154-.586-.231l7.974-4.632c2.063 2.791 4.939 5.846 8.682 7.949l5.815 9.763-4.16-8.926c1.094.493 2.2.889 3.301 1.199l7.275 12.13-5.351-11.671c1.44.283 2.849.44 4.187.505l12.009 14.186-10.12-14.149c4.497-.04 18.955 5.894 18.955 5.894s-12.153-9.263-14.158-12.268l14.163-1.609-15.239.08a32.4 32.4 0 0 0-3.782-4.272l13.735-5.28-15.115 4.065a24 24 0 0 0-3.552-2.43l9.609-4.061-11.243 3.242a23 23 0 0 0-3.257-1.172l25.125-14.59c1.802 2.126 4.202 4.318 7.229 5.784 7.759 3.757 16.689 1.343 16.689 1.343s-3.643-8.506-11.394-12.262a19 19 0 0 0-2.173-.875l2.82-1.636 28.047 8.071-17.007-14.485 6.487-3.768c3.97-3.573 7.927-7.168 11.826-10.867a343 343 0 0 0 11.538-11.359 342 342 0 0 0-15.586 4.387c-5.144 1.554-10.225 3.208-15.298 4.884l-6.899 4.007-4.319-23.473-7.539 30.359-8.364 4.858-1.484.861c.635-1.894 1.089-3.948 1.208-6.122.583-10.319-6.436-19.342-6.436-19.342s-7.969 7.699-8.55 18.02c-.295 5.221 1.36 10.109 3.064 13.666l-17.478 10.149a23.8 23.8 0 0 0 1.064-4.95l8.425-8.115-8.318 6.294c.025-1.47-.1-2.909-.329-4.294l11.074-11.057-11.436 9.256c-.462-1.969-1.116-3.797-1.812-5.412l7.69-13.157-8.474 11.464c-1.601-3.242-3.545-18.397-3.545-18.397s-2.095 15.489-4.375 19.362l-7.192-15.836 6.277 17.49a29 29 0 0 0-1.65 3.881l-7.434-10.472 6.868 12.368a23 23 0 0 0-.613 3.457l-5.65-8.065 5.549 9.917c-.058 4.791 1.453 9.244 3.03 12.567l-9.256 5.376c.252-.967.449-1.969.564-3 .913-8.2-3.689-15.014-3.689-15.014s-6.079 6.48-6.992 14.683c-.356 3.229.142 6.231.874 8.699l-4.963 2.879-12.161-11.584c-.591-1.354-1.064-2.703-1.211-4.037-.251-1.84-.078-3.66.371-5.47.442-1.808 1.282-3.601 2.217-5.389.945-1.787 1.943-3.572 2.646-5.37.762-1.796 1.111-3.608 1.553-5.42.432-1.809.876-3.618 1.208-5.432.315-1.816.491-3.637.425-5.467-.139-3.664-.881-7.354-2.127-11.067a39.5 39.5 0 0 0-2.341-5.587c-.972-1.871-2.08-3.75-3.635-5.646l-1.87-.083c-1.717 1.754-2.984 3.527-4.114 5.308a40 40 0 0 0-2.823 5.362c-1.563 3.589-2.622 7.201-3.081 10.84-.227 1.816-.21 3.647-.054 5.482.171 1.836.457 3.678.728 5.519.283 1.841.474 3.678 1.077 5.534.542 1.852 1.384 3.718 2.166 5.582.776 1.862 1.458 3.72 1.738 5.562.288 1.842.308 3.671-.103 5.48-.166.816-.464 1.624-.827 2.428l-3.037.548c-2.332 4.021-3.057 9.285-2.126 14.02.1 1.327.291 2.656.581 3.989l-17.395-12.118 7.593 24.868-2.419 3.647-7.483 4.345-1.875 1.089-4.744-17.267.698 19.617-2.429 1.411-4.514-15.62.466 17.97-.679.392-4.714-7.231-2.554 11.452c-1.135.646-2.241 1.343-3.418 1.919-.737.356-1.487.691-2.195 1.103l-.867-8.899-1.382 10.682-4.912 4.423c-1.958 1.832-3.945 3.622-5.879 5.492-3.899 3.695-7.754 7.467-11.489 11.444 5.307-1.273 10.491-2.753 15.635-4.307 2.583-.755 5.12-1.592 7.681-2.383l6.277-2.072 10.044 4.074-7.378-5.148c.706-.408 1.372-.891 2.044-1.359.881-.596 1.811-1.115 2.727-1.646l12.122 3.407-4.922-7.898.083-.047.793-.308 18.599 9.119-14.5-11.382 2.166-1.239 18.77 8.79-14.714-11.132 2.581-1.495 10.933-6.346 13.425 19.856z" fill="currentColor"/>
            <path d="m206.098 284.109-15.756-27.5 15.756-27.5h31.505l15.754 27.5-15.754 27.5z" fill="currentColor"/>
        </svg>`,
        // Mẫu 5: Nhiều tia nhỏ + tia lớn xen kẽ
        `<svg viewBox="0 0 475 511" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="m261.809 159.243 16.17 4.157c-.779-1.14-8.145-11.13-7.796-11.433q4.545-3.948 9.089-7.898 12.615-10.956 25.229-21.918l-31.069 9.309 2.483-15.176c-3.943 5.442-7.883 10.885-11.829 16.326-3.091 4.267-10.398 4.765-15.493 6.293q-.049-15.517-.095-31.035l-.007-2.391c0-.138 5.454-1.036 6.113-1.227 5.889-1.71 8.396-4.908 10.884-9.95 2.156-4.371 4.861-8.275 10.569-8.443 6.36-.311 13.948 4.817 20.115 1.82 4.48-2.174 1.394-9.33 6.367-11.564 3.23-1.454 6.187-.259 9.163-2.676a60 60 0 0 0 6.928-6.509c1.963-2.157 3.777-4.462 5.254-6.934 1.97-3.295-3.064-2.519-5.352-2.45-5.452.17-15.593.474-19.194 4.884-3.906 4.787-6.716 3.772-12.319 1.926-5.972-1.967-8.496 3.911-10.085 8.275-1.807 4.963-3.63 11.113-10.015 12.259-6.208 1.115-12.571-2.63-18.486.554q-.042-15.436-.093-30.873-.018-7.325-.044-14.652c.044-2.478.764-5.586.105-7.989-1.145-3.743-2.373-7.462-3.623-11.176-2.368-7.009-4.961-13.976-8.017-20.752-3.013 6.792-5.567 13.772-7.888 20.792a421 421 0 0 0-3.071 9.597c-.969 3.153-.415 6.339-.337 9.586l.047 15.537.095 31.735c-3.362-2.451-6.592-3.474-10.879-3.046-4.209.419-8.782 1.749-12.817-.08-8.408-3.814-5.423-15.808-13.181-19.91-3.301-1.742-7.373 1.87-10.705 2.023-4.131.305-4.895-3.435-7.639-5.289-3.25-2.471-10.215-2.827-14.221-3.191-2.336-.214-4.7-.304-7.043-.181-3.296.173-2.405 1.5-1.023 3.601 2.483 3.777 5.625 7.179 9.048 10.234 1.396 1.248 3.105 3.121 5 3.69 2.429.877 5.229-.017 7.454 1.514 3.203 2.205 2.219 6.628 3.943 9.6 2.053 3.68 8.85 2.026 12.134 1.25 4.268-1.007 9.05-2.579 13.355-.844 3.545 1.43 5.195 4.58 6.724 7.678 1.611 3.265 3.201 6.641 6.775 8.413 3.979 1.969 8.66 2.782 13.133 2.613l.1 33.455c-4.531-1.357-12.005-1.911-14.756-5.709l-12.161-16.787 2.483 15.176-31.072-9.309 24.602 21.372 9.663 8.396c.452.391-6.917 10.273-7.739 11.481q5.579-1.433 11.157-2.87c3.642-.934 4.353-1.858 7.029.464q5.087 4.418 10.173 8.839c1.823 1.583.73 6.116.735 8.345-4.644-1.123-8.203-1.84-12.974-1.769-4.446.067-7.483 3.522-10.942 6.001 8.474 3.002 15.178 6.189 23.935 2.432l.073 23.833c-2.771-1.399-5.386-3.057-7.927-4.79-.125 4.468-.254 8.934-.376 13.403-.103 3.609-.71 5.758 1.36 8.693q5.184 7.355 10.376 14.711c3.572 5.07 5.645 9.254 8.125 14.975 2.5-5.86 4.158-11.715 7.705-17.069l8.579-12.961c1.472-2.224.757-5.753.828-8.285.117-4.187.237-8.371.354-12.56-1.995 1.349-4.043 2.637-6.191 3.763l-.068-23.091c7.766 3.329 15.154-.454 22.488-3.053-2.458-1.765-6.23-5.929-9.392-5.977-4.895-.074-8.386.263-13.118 1.408-.005-2.075-.015-4.152-.017-6.225-.003-1.523 1.252-2.066 2.441-3.098z" fill="currentColor"/>
  <path d="m160.322 187.725 11.943-10.989c-1.445.06-14.402 1.017-14.507.582q-1.39-5.645-2.786-11.294l-7.729-31.344q-3.449 14.88-6.895 29.758l-12.844-9.593q4.622 8.859 9.236 17.717c2.42 4.635-.774 10.786-1.902 15.671l-28.855-15.444-2.221-1.189c-.13-.07 1.763-4.924 1.916-5.553 1.357-5.615-.359-9.241-3.791-13.77-2.98-3.927-5.254-8.066-2.55-12.76 2.89-5.299 11.442-8.862 11.744-15.343.22-4.71-7.961-5.793-7.549-10.93.266-3.336 2.854-5.127 2.097-8.742a55 55 0 0 0-2.578-8.854c-1.018-2.662-2.254-5.28-3.808-7.71-2.073-3.239-3.872 1.216-4.949 3.101-2.568 4.487-7.359 12.837-5.063 17.948 2.49 5.552.141 7.316-4.373 10.919-4.812 3.844-.618 8.821 2.637 12.288 3.704 3.943 8.503 8.49 6.372 14.223-2.068 5.571-8.726 8.838-8.726 15.213l-28.703-15.361-13.618-7.291c-2.28-1.275-4.807-3.408-7.368-4.077-4.046-.947-8.113-1.816-12.183-2.66-7.688-1.592-15.454-2.981-23.269-3.9 4.797 5.831 9.997 11.386 15.354 16.773a482 482 0 0 0 7.37 7.281c2.446 2.358 5.676 3.503 8.73 5.064l14.443 7.73 29.504 15.792c-3.955 1.49-6.518 3.59-8.269 7.266-1.716 3.612-2.769 7.972-6.482 10.317-7.744 4.89-17.385-3.523-25.071.697-3.266 1.796-1.953 6.891-3.474 9.662-1.785 3.489-5.637 2.238-8.73 3.529-3.918 1.388-7.729 6.838-10.073 9.894-1.365 1.782-2.627 3.644-3.687 5.601-1.489 2.749.19 2.695 2.83 2.628 4.746-.118 9.477-.956 14.026-2.193 1.855-.504 4.446-.947 5.92-2.194 2.031-1.528 2.6-4.233 5.134-5.267 3.65-1.486 7.261 1.522 10.88 1.615 4.44.181 6.305-6.14 7.228-9.181 1.2-3.954 2.134-8.601 5.894-11.212 3.101-2.151 6.851-1.909 10.493-1.596 3.833.331 7.76.735 11.191-1.271 3.816-2.228 6.912-5.604 8.992-9.302q15.55 8.325 31.104 16.647c-3.53 2.986-7.776 8.746-12.676 9.069-7.224.48-14.443.953-21.665 1.434q7.666 2.793 15.327 5.581l-24.172 20.452q16.066-4.597 32.136-9.19l12.622-3.612c.589-.17 6.079 10.726 6.785 11.995l2.92-10.453c.95-3.411.449-4.446 3.945-5.446l13.286-3.8c2.383-.682 6.042 2.466 8.118 3.577-3.367 3.191-5.811 5.709-8.13 9.601-2.163 3.624-.474 7.806.095 11.838 7.024-5.343 13.337-9.169 14.229-18.125l22.156 11.86c-2.685 1.539-5.532 2.825-8.408 4.01l12.248 7.005c3.301 1.887 4.993 3.453 8.748 3.249q9.421-.516 18.845-1.029c6.492-.353 11.409.066 17.959.922-4.187-4.95-8.792-9.217-11.99-14.762q-3.869-6.705-7.742-13.41c-1.33-2.305-4.961-3.489-7.27-4.813l-11.487-6.565c.256 2.286.43 4.583.401 6.882q-10.736-5.744-21.465-11.489c6.973-4.61 7.153-12.472 8.406-19.697-2.864 1.107-8.618 2.072-10.239 4.6-2.517 3.918-3.95 6.909-5.256 11.305l-5.786-3.098c-1.414-.759-1.289-2.046-1.65-3.52q-1.639-6.635-3.275-13.267" fill="currentColor"/>
  <path d="M136.015 283.967q-2.112-7.57-4.229-15.144c-.667 1.2-6.257 12.145-6.711 12.014l-11.875-3.395q-16.48-4.712-32.959-9.428 12.089 10.225 24.175 20.452l-15.327 5.582q10.534.694 21.064 1.394c5.513.364 9.622 6.018 13.591 9.375q-14.38 7.798-28.76 15.59l-2.217 1.204c-.127.071-3.687-3.887-4.197-4.326-4.53-3.902-8.753-4.33-14.675-3.818-5.137.444-10.112.207-13.12-4.32-3.467-4.987-2.502-13.679-8.366-17.163-4.26-2.533-9.355 3.536-13.919.633-2.961-1.881-3.333-4.867-7.063-6.063a65.4 65.4 0 0 0-9.507-2.345c-2.981-.506-6.028-.819-9.063-.779-4.04.056-.803 3.738.403 5.549 2.883 4.322 8.237 12.367 14.128 13.069 6.4.762 6.861 3.543 7.949 8.992 1.162 5.809 7.879 4.909 12.725 4.011 5.508-1.02 12.131-2.624 16.384 1.961 4.141 4.459 3.84 11.474 9.758 14.662-9.536 5.169-19.075 10.339-28.608 15.508q-6.789 3.684-13.582 7.362c-2.319 1.207-5.562 2.18-7.466 3.915-2.901 2.796-5.74 5.646-8.56 8.516-5.32 5.414-10.49 10.995-15.25 16.852 7.81-.961 15.563-2.388 23.241-4.02a525 525 0 0 0 10.444-2.316c3.411-.797 6.091-2.835 9.065-4.524 4.797-2.604 9.599-5.203 14.397-7.805l29.41-15.944c-.594 3.94.07 7.062 2.612 10.314 2.495 3.192 6.011 6.221 6.333 10.397.667 8.701-11.966 12.287-11.887 20.607.032 3.538 5.42 5.022 7.229 7.639 2.349 3.184-.745 5.674-1.091 8.82-.669 3.856 2.485 9.664 4.148 13.085.969 1.993 2.068 3.946 3.357 5.78 1.807 2.577 2.593 1.192 3.853-.972 2.263-3.895 3.853-8.137 4.978-12.432.459-1.749 1.343-4.069.923-5.883-.405-2.404-2.632-4.217-2.322-6.782.444-3.689 5.044-5.108 6.939-7.985 2.39-3.496-2.547-8.163-4.907-10.431-3.074-2.942-6.917-6.021-7.458-10.367-.447-3.581 1.653-6.491 3.762-9.273 2.226-2.936 4.565-5.907 4.421-9.684-.161-4.197-1.75-8.385-4.138-11.915l31.001-16.807c1.004 4.34 4.229 10.653 2.08 14.777q-4.752 9.11-9.502 18.221l12.844-9.595q3.45 14.881 6.894 29.759l7.534-30.563c.991-4.004 1.975-8.005 2.961-12.009.139-.556 12.996.454 14.529.516q-4.124-3.791-8.245-7.584c-2.688-2.474-3.899-2.587-3.083-5.909l3.115-12.639c.562-2.267 5.313-3.647 7.38-4.769 1.279 4.316 2.395 7.551 4.846 11.37 2.285 3.557 7.009 4.286 11.038 5.841-1.448-8.348-1.843-15.359-9.709-20.559l22.085-11.973c.085 2.938-.144 5.88-.479 8.8q6.309-3.198 12.625-6.394c3.401-1.725 5.701-2.309 7.388-5.447l8.467-15.74c2.92-5.425 5.767-9.19 9.834-14.054-6.687.911-12.949 2.496-19.692 2.308q-8.163-.224-16.318-.452c-2.805-.077-5.72 2.264-8.108 3.473q-5.915 2.998-11.833 5.994c2.249.938 4.468 1.949 6.589 3.121l-21.396 11.6c-.794-7.941-7.998-12.018-14.082-16.644-.405 2.87-2.383 8.001-.849 10.576 2.383 3.994 4.441 6.648 7.864 9.899l-5.767 3.126c-1.411.765-2.544.021-4.094-.424q-6.975-1.99-13.949-3.988" fill="currentColor"/>
  <path d="M213.191 351.732q-8.085-2.079-16.169-4.155c.779 1.139 8.145 11.127 7.796 11.431l-9.09 7.898-25.229 21.917q15.533-4.655 31.069-9.308c-.828 5.058-1.653 10.116-2.483 15.177 3.943-5.445 7.883-10.884 11.828-16.326 3.091-4.269 10.398-4.767 15.493-6.295q.049 15.518.095 31.036l.007 2.392c.002.136-5.454 1.034-6.113 1.226-5.889 1.71-8.399 4.908-10.884 9.949-2.156 4.374-4.861 8.277-10.569 8.442-6.36.313-13.948-4.815-20.115-1.819-4.48 2.177-1.394 9.329-6.37 11.564-3.228 1.453-6.184.26-9.16 2.676a60 60 0 0 0-6.929 6.511c-1.963 2.153-3.777 4.46-5.254 6.931-1.968 3.295 3.064 2.518 5.352 2.447 5.452-.168 15.593-.471 19.192-4.88 3.908-4.79 6.719-3.773 12.322-1.926 5.971 1.966 8.496-3.913 10.085-8.276 1.807-4.963 3.63-11.115 10.015-12.26 6.208-1.115 12.571 2.631 18.486-.555q.045 15.439.093 30.873.018 7.327.044 14.652c-.044 2.479-.764 5.587-.105 7.991 1.145 3.743 2.373 7.462 3.625 11.176 2.366 7.01 4.958 13.975 8.015 20.752 3.013-6.792 5.567-13.772 7.888-20.794a419 419 0 0 0 3.071-9.594c.969-3.155.415-6.341.337-9.589-.017-5.18-.029-10.359-.046-15.537q-.045-15.866-.095-31.737c3.362 2.453 6.592 3.475 10.879 3.048 4.209-.42 8.782-1.749 12.82.079 8.408 3.816 5.42 15.811 13.181 19.91 3.298 1.743 7.371-1.869 10.703-2.02 4.131-.306 4.895 3.434 7.639 5.288 3.249 2.471 10.215 2.827 14.221 3.193 2.337.211 4.7.301 7.043.178 3.296-.173 2.405-1.501 1.023-3.6-2.483-3.778-5.625-7.179-9.048-10.237-1.396-1.247-3.103-3.12-5-3.688-2.429-.878-5.229.016-7.454-1.515-3.203-2.206-2.219-6.631-3.943-9.599-2.053-3.68-8.85-2.027-12.134-1.252-4.268 1.01-9.051 2.579-13.354.844-3.545-1.43-5.196-4.579-6.724-7.678-1.611-3.262-3.201-6.64-6.775-8.411-3.979-1.97-8.662-2.783-13.132-2.616l-.1-33.454c4.531 1.357 12.004 1.911 14.756 5.71l12.161 16.788q-1.24-7.59-2.483-15.177 15.534 4.652 31.072 9.308l-24.602-21.372c-3.22-2.799-6.44-5.594-9.663-8.396-.452-.389 6.919-10.273 7.739-11.478q-5.579 1.431-11.157 2.865c-3.643.94-4.353 1.861-7.029-.46q-5.085-4.42-10.174-8.838c-1.824-1.585-.73-6.117-.735-8.346 4.643 1.123 8.203 1.838 12.974 1.767 4.446-.066 7.483-3.521 10.943-5.999-8.474-3.003-15.178-6.19-23.936-2.431l-.073-23.834c2.773 1.399 5.386 3.055 7.927 4.789q.191-6.699.378-13.401c.103-3.609.708-5.759-1.362-8.693q-5.184-7.359-10.376-14.712c-3.572-5.07-5.642-9.254-8.125-14.974-2.5 5.859-4.158 11.714-7.703 17.069q-4.29 6.482-8.581 12.96c-1.472 2.225-.757 5.754-.828 8.285l-.354 12.561c1.995-1.349 4.043-2.635 6.192-3.762l.068 23.09c-7.766-3.33-15.154.453-22.49 3.054 2.461 1.764 6.233 5.928 9.395 5.977 4.895.073 8.386-.262 13.118-1.409q.014 3.113.019 6.227c0 1.521-1.255 2.064-2.444 3.097q-5.334 4.638-10.674 9.275" fill="currentColor"/>
  <path d="m314.677 323.251-11.943 10.99c1.446-.063 14.402-1.018 14.507-.583l2.786 11.295q3.867 15.673 7.729 31.343 3.449-14.88 6.895-29.758c4.282 3.198 8.564 6.394 12.847 9.596a27617 27617 0 0 1-9.238-17.721c-2.42-4.634.771-10.785 1.902-15.669 9.622 5.148 19.236 10.294 28.855 15.443l2.222 1.19c.13.067-1.763 4.923-1.917 5.554-1.358 5.613.359 9.237 3.792 13.768 2.984 3.926 5.254 8.065 2.551 12.759-2.891 5.298-11.443 8.861-11.743 15.344-.22 4.708 7.959 5.792 7.546 10.931-.266 3.334-2.852 5.123-2.095 8.739a54.6 54.6 0 0 0 2.576 8.855c1.018 2.661 2.256 5.28 3.808 7.711 2.073 3.237 3.872-1.219 4.949-3.103 2.568-4.487 7.361-12.836 5.063-17.949-2.49-5.55-.141-7.316 4.373-10.919 4.814-3.841.62-8.818-2.637-12.286-3.703-3.943-8.501-8.491-6.372-14.22 2.068-5.575 8.726-8.842 8.726-15.216l28.703 15.361 13.618 7.291c2.282 1.274 4.807 3.408 7.368 4.077 4.046.946 8.113 1.816 12.183 2.659 7.688 1.593 15.454 2.982 23.269 3.901-4.795-5.832-9.998-11.385-15.354-16.774a473 473 0 0 0-7.371-7.279c-2.446-2.36-5.676-3.505-8.73-5.065l-14.443-7.732-29.504-15.791c3.955-1.491 6.521-3.59 8.269-7.266 1.716-3.612 2.769-7.972 6.482-10.317 7.744-4.89 17.385 3.523 25.071-.699 3.266-1.793 1.953-6.89 3.477-9.658 1.782-3.49 5.637-2.239 8.728-3.53 3.919-1.388 7.73-6.84 10.073-9.894 1.365-1.781 2.63-3.644 3.687-5.6 1.489-2.749-.191-2.695-2.83-2.628-4.746.118-9.475.957-14.026 2.195-1.855.503-4.446.946-5.92 2.194-2.031 1.527-2.6 4.232-5.134 5.267-3.65 1.484-7.261-1.523-10.879-1.615-4.441-.182-6.306 6.139-7.229 9.18-1.196 3.954-2.131 8.602-5.896 11.213-3.098 2.15-6.848 1.908-10.491 1.594-3.833-.331-7.759-.733-11.192 1.27-3.816 2.229-6.911 5.605-8.992 9.303l-31.101-16.646c3.528-2.986 7.774-8.745 12.676-9.069l21.663-1.433-15.325-5.582q12.083-10.227 24.17-20.452l-32.134 9.192-12.625 3.609c-.588.17-6.079-10.725-6.785-11.993q-1.46 5.225-2.917 10.453c-.952 3.41-.452 4.448-3.948 5.447l-13.286 3.799c-2.383.684-6.042-2.466-8.118-3.578 3.367-3.19 5.811-5.707 8.13-9.6 2.163-3.625.474-7.805-.095-11.838-7.024 5.344-13.337 9.169-14.229 18.124l-22.156-11.858c2.685-1.54 5.532-2.826 8.408-4.01-4.082-2.337-8.167-4.67-12.249-7.007-3.301-1.887-4.99-3.451-8.748-3.247l-18.845 1.028c-6.492.354-11.409-.066-17.959-.922 4.187 4.951 8.792 9.218 11.99 14.761q3.869 6.705 7.742 13.412c1.33 2.306 4.961 3.49 7.271 4.813q5.746 3.282 11.487 6.566c-.256-2.287-.425-4.585-.401-6.884q10.736 5.743 21.465 11.489c-6.973 4.611-7.153 12.472-8.406 19.698 2.864-1.108 8.618-2.073 10.239-4.601 2.517-3.919 3.953-6.909 5.256-11.304 1.931 1.032 3.855 2.064 5.786 3.098 1.414.757 1.292 2.045 1.653 3.519z" fill="currentColor"/>
  <path d="M338.984 227.008c1.411 5.049 2.818 10.094 4.229 15.145.667-1.2 6.257-12.146 6.712-12.016 3.96 1.133 7.917 2.262 11.875 3.395l32.961 9.427a46279 46279 0 0 1-24.175-20.451l15.325-5.582q-10.534-.694-21.064-1.394c-5.513-.363-9.624-6.018-13.592-9.374 9.588-5.198 19.172-10.396 28.76-15.592l2.217-1.204c.127-.07 3.687 3.889 4.197 4.327 4.531 3.904 8.753 4.33 14.675 3.821 5.137-.448 10.112-.211 13.12 4.318 3.467 4.986 2.502 13.679 8.369 17.163 4.258 2.532 9.355-3.536 13.916-.635 2.961 1.883 3.333 4.868 7.063 6.063a65.4 65.4 0 0 0 9.509 2.346c2.979.507 6.026.818 9.063.779 4.041-.056.801-3.737-.405-5.551-2.883-4.32-8.235-12.366-14.129-13.065-6.399-.763-6.86-3.545-7.949-8.994-1.16-5.81-7.879-4.91-12.725-4.011-5.508 1.021-12.129 2.622-16.384-1.963-4.141-4.458-3.84-11.472-9.758-14.66l28.608-15.508c4.529-2.456 9.053-4.912 13.582-7.362 2.319-1.207 5.561-2.18 7.466-3.914 2.9-2.797 5.74-5.647 8.56-8.517 5.32-5.414 10.491-10.995 15.251-16.853-7.808.962-15.564 2.389-23.242 4.021a522 522 0 0 0-10.442 2.316c-3.413.796-6.094 2.836-9.068 4.525q-7.196 3.904-14.397 7.805l-29.409 15.943c.594-3.939-.071-7.062-2.612-10.314-2.495-3.191-6.011-6.221-6.333-10.395-.667-8.704 11.963-12.287 11.887-20.609-.032-3.534-5.42-5.021-7.226-7.638-2.351-3.184.742-5.674 1.089-8.819.669-3.857-2.485-9.664-4.148-13.086-.969-1.993-2.068-3.948-3.357-5.78-1.807-2.575-2.593-1.19-3.85.972-2.266 3.895-3.852 8.137-4.98 12.43-.459 1.751-1.343 4.07-.923 5.885.405 2.402 2.632 4.218 2.322 6.781-.444 3.691-5.044 5.106-6.936 7.983-2.392 3.499 2.544 8.164 4.905 10.431 3.074 2.943 6.922 6.023 7.458 10.37.447 3.579-1.653 6.489-3.762 9.271-2.224 2.936-4.565 5.907-4.421 9.684.161 4.199 1.75 8.386 4.138 11.917q-15.499 8.403-31.001 16.805c-1.004-4.34-4.226-10.654-2.08-14.778l9.505-18.221q-6.426 4.801-12.847 9.595-3.449-14.88-6.895-29.757l-7.534 30.561c-.991 4.004-1.975 8.004-2.961 12.009-.139.558-12.996-.453-14.529-.515q4.124 3.79 8.245 7.583c2.688 2.474 3.901 2.588 3.083 5.909q-1.558 6.317-3.115 12.639c-.562 2.267-5.313 3.65-7.38 4.769-1.277-4.316-2.395-7.551-4.846-11.368-2.283-3.558-7.009-4.286-11.035-5.842 1.445 8.35 1.841 15.359 9.707 20.559-7.363 3.989-14.722 7.982-22.085 11.971-.085-2.937.144-5.878.479-8.797-4.207 2.129-8.413 4.263-12.625 6.393-3.401 1.724-5.698 2.307-7.388 5.447l-8.467 15.739c-2.92 5.425-5.766 9.188-9.834 14.054 6.687-.911 12.949-2.495 19.693-2.308q8.163.225 16.318.452c2.808.077 5.723-2.266 8.108-3.471q5.915-3 11.833-5.996c-2.249-.939-4.468-1.949-6.589-3.12q10.7-5.803 21.396-11.6c.793 7.939 7.998 12.018 14.082 16.643.405-2.87 2.385-8.003.849-10.578-2.38-3.993-4.441-6.648-7.864-9.897l5.766-3.125c1.411-.764 2.544-.022 4.097.423 4.645 1.33 9.296 2.659 13.944 3.991" fill="currentColor"/>
  <path d="M252.175 255.31c0 7.745-6.729 14.027-15.032 14.027s-15.032-6.282-15.032-14.027 6.728-14.023 15.032-14.023 15.032 6.279 15.032 14.023" fill="currentColor"/>
</svg>`,
`<svg viewBox="0 0 438 505" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="m16.958 144.432 5.283 5.363c-4.203 2.495-8.296 5.529-8.296 5.529s12.111 1.345 16.957.038c.138-.038.269-.086.404-.13l18.731 10.814.077.042c-7.234 3.692-16.238 10.36-16.238 10.36s17.62 1.956 24.674.055c1.929-.521 3.623-1.488 5.079-2.611l14.346 8.282c-7.235 3.69-16.237 10.359-16.237 10.359s17.62 1.959 24.674.055c1.929-.521 3.622-1.488 5.078-2.611l13.214 7.631 22.301 12.874q-.02.008-.042.011c-12.997 3.507-39.246 22.96-39.246 22.96s32.471 3.609 45.467.102c6.693-1.809 11.904-6.497 15.39-10.62l10.797 6.237 1.343.775c-7.234 3.69-16.237 10.359-16.237 10.359s17.62 1.956 24.673.055c1.93-.521 3.623-1.488 5.079-2.611l5.642 3.258c1.13.668 2.3 1.273 3.38 2.035 1.072.77 2.107 1.611 3.399 2.001 2.622.72 5.268 1.396 7.906 2.088 2.67.638 5.305 1.332 8.003 1.92 5.361 1.233 10.779 2.371 16.352 3.238-3.537-4.392-7.232-8.518-10.982-12.543-1.858-2.041-3.777-3.978-5.664-5.97-1.917-1.942-3.826-3.893-5.762-5.802-.983-.927-2.228-1.4-3.432-1.946-1.198-.553-2.307-1.266-3.454-1.909l-5.804-3.351c.178-1.677.122-3.455-.347-5.211-1.878-7.058-12.384-21.338-12.384-21.338s-1.218 10.636-.88 18.691l-1.085-.628-10.874-6.277c1.744-5.028 3.054-11.668 1.328-18.159-3.46-13.009-22.821-39.328-22.821-39.328s-3.602 31.455-.409 44.839L114.45 180.72l-13.378-7.721c.178-1.68.122-3.455-.345-5.214-1.879-7.058-12.385-21.338-12.385-21.338s-1.22 10.636-.879 18.692l-14.252-8.225c.178-1.68.121-3.455-.346-5.214-1.878-7.058-12.384-21.338-12.384-21.338s-1.218 10.636-.88 18.69l-18.915-10.918c-1.415-4.91-8.457-14.485-8.457-14.485s-.546 4.759-.635 9.504l-7.067-1.838c-2.666-.644-5.307-1.329-7.998-1.929-5.355-1.246-10.757-2.411-16.289-3.349 3.576 4.324 7.286 8.419 11.042 12.433 1.87 2.032 3.785 3.977 5.676 5.962m-1.528-10.297c1.799.399 3.536.832 5.273 1.26q1.34.334 2.682.661l12.573 3.268.593 2.049 28.296 16.335-.373-8.861a73 73 0 0 1-.05-3.679c1.792 3.058 3.234 5.904 3.736 7.787.271 1.022.343 2.183.21 3.444l-.335 3.151 24.673 14.245-.371-8.857a74 74 0 0 1-.051-3.683c1.791 3.06 3.235 5.907 3.735 7.787.272 1.022.342 2.184.21 3.446l-.333 3.151 47.815 27.606-2.626-11.017c-1.607-6.726-1.311-19.454-.643-29.841 5.906 8.921 12.676 20.154 14.421 26.713 1.467 5.515.145 11.368-1.223 15.307l-1.322 3.806 23.129 13.353-.372-8.861a73 73 0 0 1-.05-3.679c1.792 3.058 3.234 5.907 3.735 7.787.271 1.022.343 2.18.21 3.444l-.335 3.15 8.549 4.934c.364.206.677.39.99.574.842.493 1.797 1.049 2.851 1.537l.566.252c.605.268 1.29.572 1.554.801a450 450 0 0 1 4.355 4.378l1.263 1.283q1.001 1.055 2.01 2.098c1.235 1.286 2.4 2.499 3.555 3.767q.864.925 1.67 1.803c-.762-.17-1.54-.345-2.344-.532a194 194 0 0 1-5.122-1.216c-.93-.227-1.861-.458-2.794-.682l-1.774-.463a414 414 0 0 1-5.938-1.573c-.332-.115-.938-.555-1.475-.951l-.455-.331c-.988-.696-1.951-1.244-2.799-1.729a42 42 0 0 1-.941-.543l-8.519-4.921-2.587 1.998c-1.132.873-2.265 1.465-3.371 1.764-.92.247-3.186.663-8.054.663h-.559a68 68 0 0 1 3.664-2.03l7.994-4.077-23.445-13.531-2.63 3.113c-2.781 3.29-7.283 7.532-12.938 9.058-2.305.621-6.939 1.364-15.908 1.364-4.898 0-9.979-.219-14.436-.498 8.869-5.916 20.031-12.697 26.593-14.493l11.492-3.063-48.555-28.035-2.586 1.995c-1.133.874-2.267 1.469-3.373 1.768-.917.246-3.184.663-8.049.663l-.563-.002a67 67 0 0 1 3.663-2.028l7.991-4.08-24.944-14.401-2.587 1.995c-1.133.874-2.267 1.468-3.374 1.767-.915.247-3.182.661-8.048.661h-.564a68 68 0 0 1 3.663-2.028l8.035-4.102-7.832-4.474-20.665-11.932-2.01.652-9.426-9.564c-.57-.6-1.201-1.257-1.833-1.913-1.247-1.295-2.497-2.591-3.721-3.926l-1.384-1.484q.945.206 1.938.442m193.37 17.632c-9.748-9.482-39.171-22.307-39.171-22.307s12.93 29.928 22.465 39.429c4.911 4.894 11.831 7.06 16.706 8.018v14.018c-5.849-4.419-16.846-8.882-16.846-8.882s6.992 16.239 12.166 21.395c1.416 1.411 3.706 2.394 4.68 3.093v6.515c0 1.315.29 2.63.169 3.945-.129 1.315-.22 2.63.09 3.945.686 2.63 1.484 5.26 2.205 7.891.786 2.63 1.533 5.26 2.368 7.891 1.614 5.26 3.354 10.521 5.391 15.781 2.036-5.26 3.767-10.521 5.381-15.781.838-2.631 1.558-5.26 2.341-7.891.723-2.631 1.458-5.26 2.146-7.891.307-1.315-.144-2.63-.276-3.945-.12-1.315.659-2.631-.315-3.945v-6.702c1.948-.687 3.296-1.622 4.585-2.906 5.171-5.156 12.163-21.395 12.163-21.395s-9.924 4.263-16.748 8.584v-13.809c5.85-1.003 11.875-3.19 16.636-7.93 9.534-9.501 22.525-39.429 22.525-39.429s-28.438 12.608-39.16 22.066v-40.723c1.948-.685 3.296-1.622 4.585-2.904 5.171-5.156 12.163-21.395 12.163-21.395s-9.924 4.262-16.748 8.584V78.632c1.948-.686 3.296-1.622 4.585-2.905 5.171-5.156 12.163-21.394 12.163-21.394s-9.924 4.263-16.748 8.583V41.075c3.899-3.68 8.555-14.565 8.555-14.565s-4.27 1.907-8.425 4.203l-1.88-7.041c-.776-2.631-1.472-5.26-2.297-7.891-1.597-5.26-3.274-10.521-5.229-15.781-1.958 5.26-3.643 10.521-5.239 15.781-.825 2.63-1.548 5.26-2.324 7.891l-1.997 7.258c-4.265-2.393-8.935-4.42-8.935-4.42s4.643 11.16 8.201 14.702c.1.104.073.189.073.284v21.716c-5.849-4.419-16.846-8.88-16.846-8.88s6.992 16.238 12.166 21.394c1.416 1.409 3.706 2.393 4.68 3.091v16.568c-5.849-4.422-16.846-8.882-16.846-8.882s6.992 16.239 12.166 21.395c1.416 1.411 3.706 2.394 4.68 3.093v40.776zm-1.241-47.321c-1.406-1.403-3.181-4.163-4.949-7.32 1.187.707 2.302 1.432 3.252 2.147l7.813 5.904V76.319l-2.031-1.46c-.544-.389-1.143-.726-1.777-1.083-.774-.434-1.831-1.03-2.307-1.504-1.406-1.403-3.181-4.159-4.949-7.318 1.187.707 2.302 1.431 3.252 2.149l7.813 5.904V41.584a5.1 5.1 0 0 0-1.152-3.428l3.638-13.189c.239-.82.498-1.721.762-2.622.488-1.702.977-3.406 1.513-5.108q.275-.915.581-1.907l.572 1.865c.503 1.607.942 3.159 1.406 4.801.283.997.566 1.995.859 2.992l3.298 12.343a5 5 0 0 1-.2.2l-1.528 1.44v32.798l7.483-4.736a71 71 0 0 1 3.467-2.05c-1.768 3.151-3.53 5.894-4.932 7.29-.894.888-1.641 1.365-2.761 1.759l-3.257 1.146v28.762l7.483-4.737a70 70 0 0 1 3.467-2.047c-1.768 3.148-3.53 5.891-4.932 7.289-.894.887-1.641 1.363-2.761 1.759l-3.257 1.145v54.974l8.098-7.143c5.683-5.011 16.987-11.121 25.776-15.502-4.731 9.554-11.016 20.981-15.806 25.754-3.408 3.395-7.993 5.546-14.019 6.578l-4.05.693v26.776l7.483-4.738a74 74 0 0 1 3.467-2.047c-1.768 3.152-3.53 5.893-4.932 7.289-.894.888-1.641 1.363-2.761 1.759l-3.257 1.145v11.768l.415.559c-.078.583-.159 1.33-.081 2.211.056.553.139 1.06.227 1.567.054.307.125.714.134.915a406 406 0 0 1-1.563 5.759l-.498 1.816c-.273.909-.537 1.819-.801 2.732-.5 1.731-.974 3.367-1.502 5.022-.251.814-.495 1.605-.74 2.38q-.358-1.136-.722-2.328a262 262 0 0 1-1.695-5.601l-.649-2.2a335 335 0 0 0-.901-3.201 191 191 0 0 1-1.255-4.512c-.13-.594-.061-1.464.027-2.302.112-1.257.012-2.354-.068-3.235-.039-.447-.078-.872-.078-1.195v-9.016l-2.031-1.457c-.544-.39-1.143-.726-1.777-1.085-.774-.433-1.831-1.028-2.305-1.501-1.409-1.403-3.184-4.159-4.951-7.318 1.189.707 2.302 1.43 3.252 2.147l7.813 5.902v-27.822l-3.935-.773c-4.258-.834-10.176-2.672-14.208-6.688-4.812-4.795-11.102-16.288-15.822-25.864 9.442 4.685 20.774 10.905 25.693 15.686l8.271 8.036v-54.801l-2.031-1.459c-.544-.388-1.143-.729-1.777-1.084-.773-.433-1.83-1.028-2.307-1.499m-37.338 187.071c-.42 8.111.853 19.241.853 19.241s10.507-14.28 12.384-21.338c.514-1.931.524-3.882.278-5.706l5.642-3.255c1.146-.647 2.256-1.356 3.455-1.911 1.204-.542 2.449-1.019 3.433-1.945 1.933-1.91 3.845-3.861 5.759-5.803 1.887-1.992 3.806-3.93 5.664-5.971 3.75-4.027 7.444-8.15 10.982-12.543-5.571.869-10.991 2.006-16.352 3.239-2.698.59-5.333 1.282-8.003 1.92-2.639.688-5.285 1.365-7.906 2.089-1.293.388-2.326 1.23-3.4 2-1.079.761-2.25 1.367-3.379 2.036l-5.805 3.351c-1.366-.992-2.932-1.831-4.689-2.305-7.051-1.901-24.672.055-24.672.055s8.604 6.376 15.749 10.11l-1.085.625-10.875 6.279c-3.479-4.025-8.577-8.479-15.062-10.231-12.995-3.507-45.466.101-45.466.101s25.438 18.848 38.627 22.773l-21.891 12.639-13.375 7.722c-1.365-.991-2.932-1.829-4.688-2.305-7.052-1.9-24.672.056-24.672.056s8.603 6.375 15.747 10.107l-14.249 8.227c-1.365-.991-2.932-1.828-4.688-2.305-7.052-1.902-24.673.056-24.673.056s8.604 6.375 15.747 10.108l-18.912 10.918c-4.961-1.226-16.774.083-16.774.083s3.85 2.852 7.916 5.305l-5.127 5.2c-1.89 1.987-3.805 3.931-5.672 5.962-3.756 4.014-7.464 8.11-11.042 12.434 5.534-.938 10.935-2.102 16.289-3.349 2.69-.601 5.332-1.284 7.998-1.929l7.285-1.895c.061 4.888.641 9.946.641 9.946s7.22-9.812 8.511-14.666c.038-.137.058-.276.088-.413l18.731-10.815.076-.047c-.419 8.113.853 19.243.853 19.243s10.508-14.28 12.385-21.341c.514-1.928.522-3.882.278-5.706l14.346-8.284c-.421 8.11.853 19.243.853 19.243s10.505-14.28 12.385-21.34c.514-1.929.523-3.882.277-5.705l13.214-7.627 22.302-12.876-.014.044c-3.461 13.005.261 45.464.261 45.464s19.36-26.316 22.822-39.326c1.781-6.697.326-13.554-1.501-18.633l10.797-6.235zm-16.726 8.663c1.459 4.053 2.882 10.073 1.377 15.732-1.745 6.558-8.518 17.793-14.424 26.714-.689-10.64-.982-23.708.745-30.288l3.054-11.455-48.517 28.013.435 3.237c.19 1.416.138 2.698-.156 3.804-.502 1.882-1.945 4.729-3.734 7.788a69 69 0 0 1 .073-4.184l.466-8.96-24.945 14.404.435 3.235c.19 1.416.137 2.698-.157 3.801-.502 1.887-1.942 4.734-3.734 7.788a70 70 0 0 1 .074-4.184l.469-9.038-7.805 4.585-20.655 11.926-.438 2.065-12.997 3.382c-.813.193-1.706.415-2.601.637-1.736.43-3.473.862-5.229 1.252q-1.016.236-1.981.454.659-.71 1.356-1.455a225 225 0 0 1 3.71-3.911q.967-1.007 1.932-2.017l9.119-9.255c.06.012 2.071.513 2.071.513l28.294-16.338-7.859-4.106a75 75 0 0 1-3.218-1.799h.565c4.865 0 7.132.413 8.049.659 1.024.278 2.063.796 3.089 1.543l2.563 1.863 24.672-14.246-7.859-4.109a68 68 0 0 1-3.219-1.797l.566-.002c4.865 0 7.131.415 8.049.664 1.023.276 2.063.796 3.089 1.543l2.561 1.86 47.815-27.605-10.852-3.235c-6.622-1.968-17.496-8.588-26.16-14.361 4.456-.279 9.534-.502 14.43-.502 8.971 0 13.602.746 15.91 1.365 5.51 1.488 9.918 5.561 12.644 8.717l2.635 3.044 23.13-13.353-7.859-4.106a73 73 0 0 1-3.218-1.801h.565c4.866 0 7.132.414 8.049.663 1.022.277 2.062.795 3.088 1.539l2.561 1.864 8.549-4.935c.359-.21.674-.391.989-.569.849-.486 1.81-1.032 2.759-1.701l.502-.361c.536-.392 1.14-.836 1.469-.949 1.963-.54 3.94-1.055 5.917-1.57l1.794-.466c.939-.224 1.874-.457 2.81-.687 1.734-.427 3.373-.832 5.052-1.2q1.234-.283 2.398-.546c-.528.576-1.07 1.162-1.631 1.768a212 212 0 0 1-3.616 3.827c-.664.688-1.328 1.378-1.988 2.078l-1.278 1.295a447 447 0 0 1-4.34 4.365c-.265.23-.952.531-1.561.799l-.514.231c-1.099.506-2.058 1.068-2.903 1.564-.311.18-.622.365-.936.539l-8.519 4.918.436 3.237c.19 1.419.137 2.695-.157 3.799-.5 1.885-1.943 4.732-3.733 7.788-.013-1.44.005-2.856.073-4.18l.466-8.965-23.44 13.538zm113.139-105.731s-10.444 14.386-12.324 21.446c-.512 1.932-.586 3.771-.215 5.812l-5.645 3.257c-1.626-.189-2.378 1.143-3.574 1.697-1.206.544-2.51.912-3.496 1.838-1.934 1.909-3.872 3.807-5.791 5.751-1.885 1.991-3.818 3.904-5.679 5.945-3.75 4.025-7.451 8.137-10.989 12.529 5.573-.868 10.989-2.01 16.35-3.243 2.698-.59 5.332-1.288 8.003-1.924 2.637-.691 5.281-1.37 7.903-2.091 1.291-.388 2.449-1.018 3.523-1.791 1.077-.759 2.361-1.168 3.501-1.825l5.806-3.353c1.079.504 2.808 1.621 4.563 2.096 7.051 1.901 24.731.049 24.731.049s-9.021-7.096-15.686-10.002l1.084-.625 10.876-6.28c3.303 3.721 8.454 8.272 14.939 10.02 12.998 3.506 45.53.005 45.53.005s-25.501-18.956-38.567-22.67l21.89-12.638 13.379-7.723c1.079.502 2.808 1.621 4.566 2.096 7.051 1.898 24.731.049 24.731.049s-9.018-7.098-15.688-10.003l14.25-8.227c1.082.5 2.81 1.619 4.568 2.092 7.051 1.902 24.731.05 24.731.05s-9.023-7.096-15.688-10l18.916-10.922c4.648.693 16.651-.293 16.651-.293s-3.911-2.959-7.976-5.408l5.095-5.255c1.89-1.99 3.789-3.956 5.654-5.987 3.76-4.015 7.461-8.124 11.035-12.448-5.532.938-10.938 2.094-16.294 3.34-2.688.6-5.332 1.285-7.998 1.926l-7.285 1.896c-.061-4.89-.64-9.951-.64-9.951s-7.099 10.026-8.391 14.877c-.037.138-.369-.265.036.628l-18.731 10.814-.078.044c.415-8.12-.976-19.452-.976-19.452s-10.444 14.383-12.324 21.444c-.513 1.931-.586 3.773-.215 5.811l-14.346 8.282c.415-8.12-.976-19.452-.976-19.452s-10.444 14.386-12.324 21.444c-.513 1.931-.586 3.773-.215 5.812l-13.215 7.629-22.302 12.875c-.479-.85-.113-.238-.108-.255 3.462-13.005-.322-45.571-.322-45.571s-19.268 26.474-22.729 39.484c-1.782 6.701-.505 13.252 1.592 18.795l-10.796 6.235-1.343.775c.412-8.12-.977-19.454-.977-19.454m19.141 14.594-1.465-3.874c-2.231-5.901-2.705-11.074-1.445-15.819 1.748-6.559 8.482-17.831 14.36-26.798.662 10.038 1.689 23.26.288 30.139-.298 3.41-2.7 12.485-2.7 12.485l47.432-28.734-.615-3.378c-.239-1.332-.2-2.433.132-3.685.508-1.907 1.973-4.811 3.779-7.924a68 68 0 0 1-.059 4.427l-.459 8.952 25.083-14.478-.615-3.375c-.239-1.334-.2-2.439.132-3.688.508-1.911 1.97-4.811 3.779-7.926a66 66 0 0 1-.059 4.43l-.461 9.036 7.8-4.584 18.672-10.781h1.34l.251-.918 2.339-1.352-.737-1.625 11.978-3.115c.805-.192 1.694-.411 2.578-.63 1.748-.431 3.494-.863 5.259-1.259q1.028-.238 2.017-.462-.672.73-1.382 1.485a345 345 0 0 1-4.302 4.564l-1.323 1.392-9.243 9.531q-.16-.018-.278-.038l-1.684-.249-28.75 16.6 8.855 3.86c.93.405 1.917.907 2.927 1.466h-.283c-5.146 0-7.519-.43-8.471-.691-.706-.188-1.67-.703-2.442-1.12a27 27 0 0 0-1.343-.687l-2.297-1.066-24.807 14.324 8.852 3.86c.933.403 1.922.907 2.935 1.466h-.291c-5.144 0-7.517-.43-8.472-.687-.705-.192-1.667-.707-2.439-1.121a28 28 0 0 0-1.345-.691l-2.295-1.063-47.437 27.385 11.082 3.151c6.528 1.854 17.358 8.433 26.006 14.201-4.339.257-9.268.46-14.038.46-9.233 0-13.974-.757-16.328-1.389-5.401-1.46-9.814-5.458-12.563-8.553l-2.639-2.97-23.772 13.721 8.858 3.86c.93.405 1.919.909 2.93 1.469h-.288c-5.141 0-7.515-.432-8.471-.687-.703-.192-1.667-.709-2.442-1.127-.5-.265-.952-.507-1.336-.685l-2.297-1.068-8 4.619c-.281.162-.667.343-1.077.529-.803.373-1.802.834-2.793 1.532-.752.542-1.421.893-2.075 1.096-2.026.555-4.068 1.088-6.109 1.621l-1.616.42c-.954.227-1.904.463-2.851.698-1.719.427-3.345.83-5.01 1.195q-1.214.278-2.363.533c.559-.605 1.099-1.185 1.611-1.737 1.118-1.227 2.222-2.363 3.391-3.569q1.118-1.144 2.224-2.31a436 436 0 0 1 4.58-4.551l1.055-1.041c.151-.107.73-.346 1.113-.502.349-.142.698-.285 1.038-.438.837-.386 1.453-.835 1.921-1.194l.693.079 10.005-5.777-.61-3.375c-.239-1.334-.203-2.438.132-3.685.505-1.907 1.968-4.811 3.779-7.926.025 1.532.01 3.036-.058 4.428l-.459 8.956zm-18.184 166.496s-13.477-29.929-23.012-39.429c-4.912-4.895-11.406-7.06-17.256-8.017v-14.018c6.826 4.419 17.578 8.882 17.578 8.882s-7.359-16.238-12.534-21.394c-1.411-1.411-3.093-2.395-5.044-3.096v-6.513c.977-1.314.442-2.632.562-3.945.132-1.314.586-2.632.278-3.945-.688-2.63-1.301-5.26-2.024-7.891-.784-2.631-1.438-5.26-2.278-7.891-1.611-5.26-3.306-10.521-5.342-15.781-2.036 5.26-3.745 10.521-5.359 15.781-.837 2.63-1.545 5.26-2.331 7.891-.72 2.63-1.45 5.26-2.139 7.891-.308 1.313-.583 2.632-.452 3.945.117 1.313-.412 2.632-.412 3.945v6.701c-.977.686-2.566 1.624-3.852 2.908-5.174 5.156-12.533 21.394-12.533 21.394s10.536-4.263 16.385-8.584v13.808c-4.875 1.003-11.146 3.191-15.904 7.93-9.534 9.5-22.89 39.429-22.89 39.429s29.044-12.61 38.794-22.068v40.722c-.977.688-2.566 1.623-3.852 2.908-5.174 5.156-12.533 21.394-12.533 21.394s10.536-4.262 16.385-8.584v16.455c-.977.686-2.566 1.624-3.852 2.908-5.174 5.156-12.533 21.391-12.533 21.391s10.536-4.263 16.385-8.584v21.843c-2.925 3.679-7.827 14.563-7.827 14.563s4.639-1.907 8.792-4.202l2.063 7.041a507 507 0 0 0 2.388 7.891c1.599 5.261 3.323 10.52 5.278 15.781 1.956-5.261 3.662-10.52 5.264-15.781.82-2.629 1.557-5.261 2.331-7.891l2.005-7.259c4.265 2.393 8.94 4.419 8.94 4.419s-5.376-11.157-8.933-14.705c-.1-.098.173-.185-.803-.281v-21.717c6.826 4.419 17.578 8.88 17.578 8.88s-7.359-16.235-12.532-21.394c-1.414-1.409-3.096-2.392-5.047-3.091v-16.567c6.826 4.419 17.578 8.882 17.578 8.882s-7.359-16.238-12.532-21.394c-1.414-1.411-3.096-2.395-5.047-3.093v-41.011c.977.01.508.022.518.029 9.536 9.503 39.751 22.514 39.751 22.514m-45.669-35.721.527 57.622 3.227 1.155c1.372.491 2.402 1.113 3.252 1.958 1.416 1.411 3.237 4.175 5.066 7.341a64 64 0 0 1-4.021-2.373l-7.524-4.873v28.96l3.227 1.157c1.372.493 2.405 1.116 3.252 1.961 1.411 1.409 3.232 4.172 5.063 7.339a62 62 0 0 1-4.019-2.373l-7.524-4.873v35.105l2.251.22-3.284 11.885c-.224.757-.466 1.594-.711 2.429-.513 1.767-1.025 3.535-1.577 5.303l-.618 2.014q-.303-.976-.605-1.973a463 463 0 0 1-2.375-7.857l-3.775-12.868-.356.198a7 7 0 0 1 .244-.32l1.055-1.333v-33.201l-7.768 5.74a34 34 0 0 1-2.41 1.609c1.775-3.045 3.523-5.679 4.892-7.043.662-.661 1.575-1.27 2.38-1.807.305-.203.586-.391.835-.567l2.07-1.455V400.25l-7.768 5.74a35 35 0 0 1-2.41 1.609c1.775-3.044 3.523-5.681 4.892-7.046.662-.659 1.575-1.267 2.38-1.804q.46-.307.835-.567l2.07-1.458v-54.773l-8.266 8.022c-4.859 4.707-15.849 10.762-25.105 15.362 4.84-9.563 11.237-20.991 16.034-25.771 4.018-4.004 9.53-5.803 13.446-6.609l3.891-.798v-27.446l-7.768 5.74a34 34 0 0 1-2.41 1.609c1.775-3.047 3.523-5.684 4.892-7.046.659-.659 1.572-1.267 2.375-1.804.308-.203.591-.393.84-.567l2.07-1.457v-9.233c0-.154.078-.586.137-.904.161-.886.381-2.097.259-3.477-.061-.601.127-1.479.327-2.339a466 466 0 0 1 1.687-6.235l.408-1.484q.423-1.434.835-2.864c.483-1.687.942-3.281 1.455-4.89.22-.724.457-1.488.706-2.279q.355 1.143.689 2.227c.481 1.515.886 2.979 1.321 4.526.303 1.094.605 2.184.93 3.278.417 1.522.798 3.045 1.179 4.569.249 1.005.503 2.003.761 3.007-.012.2-.083.608-.136.913a21 21 0 0 0-.22 1.523 12.5 12.5 0 0 0-.005 1.963q0 .033.003.066l-.583.788v11.558l3.227 1.155c1.372.493 2.402 1.116 3.25 1.955 1.414 1.416 3.237 4.18 5.068 7.346-1.421-.779-2.795-1.577-4.021-2.375l-7.524-4.871v27.127l4.087.669c6.284 1.026 11.196 3.267 14.605 6.66 4.804 4.79 11.25 16.245 16.133 25.818-9.258-4.543-21.465-9.394-26.577-14.094-.743-1.051-8.773-11.471-8.773-11.471m198.704 20.75-5.283-5.361c4.204-2.498 8.298-5.532 8.298-5.532s-12.231-1.135-17.08.173c-.137.039.044-.454-.527.344l-18.73-10.813-.076-.044c7.241-3.701 16.36-10.574 16.36-10.574s-17.681-1.853-24.737.049c-1.928.525-3.554 1.382-5.137 2.722l-14.346-8.286c7.239-3.699 16.357-10.571 16.357-10.571s-17.68-1.85-24.736.049c-1.929.522-3.559 1.38-5.137 2.72l-13.215-7.627-22.302-12.878c.495-.838.151-.217.166-.222 12.993-3.506 39.307-23.063 39.307-23.063s-32.563-3.452-45.562.055c-6.692 1.808-11.726 6.189-15.479 10.778l-10.801-6.233-1.34-.775c7.239-3.701 16.36-10.573 16.36-10.573s-17.681-1.852-24.736.052c-1.929.52-3.559 1.377-5.139 2.717l-5.642-3.258c-.652-1.501-2.178-1.487-3.257-2.249-1.074-.77-2.046-1.719-3.34-2.107-2.622-.721-5.234-1.453-7.876-2.14-2.671-.638-5.291-1.356-7.988-1.946-5.361-1.235-10.771-2.386-16.345-3.252 3.538 4.392 7.237 8.51 10.984 12.538 1.86 2.041 3.779 3.972 5.669 5.967 1.914 1.94 3.823 3.89 5.762 5.799.981.927 2.107 1.612 3.311 2.155 1.196.555 2.192 1.463 3.333 2.12l5.803 3.35c.107 1.186.002 3.245.469 5 1.88 7.06 12.324 21.445 12.324 21.445s1.636-11.362.82-18.587l1.084.628 10.874 6.277c-1.568 4.724-2.935 11.458-1.206 17.952 3.462 13.005 22.759 39.429 22.759 39.429s3.667-31.563.352-44.734l21.89 12.639 13.374 7.72c.107 1.191.002 3.245.469 5.005 1.88 7.056 12.324 21.443 12.324 21.443s1.636-11.36.82-18.586l14.248 8.227c.107 1.186.002 3.242.469 5 1.88 7.058 12.324 21.445 12.324 21.445s1.636-11.362.82-18.589l18.911 10.92c1.728 4.375 8.584 14.273 8.584 14.273s.605-4.866.693-9.609l7.1 1.784c2.666.645 5.322 1.304 8.012 1.905 5.354 1.247 10.762 2.397 16.297 3.335-3.577-4.323-7.283-8.427-11.04-12.441-1.866-2.032-3.778-3.976-5.67-5.965m1.516 10.322a318 318 0 0 1-6.123-1.445l-1.851-.447-12.876-3.242c-.039-.09-.073-.173-.108-.259l-.625-1.582-28.75-16.599 1.084 9.599c.112.986.171 2.09.188 3.255-1.809-3.11-3.269-6.011-3.777-7.915-.186-.703-.22-1.794-.249-2.671a24 24 0 0 0-.078-1.509l-.225-2.522-24.805-14.324 1.084 9.599c.112.987.171 2.09.19 3.257-1.812-3.113-3.271-6.011-3.779-7.915-.186-.706-.22-1.797-.249-2.671a31 31 0 0 0-.076-1.514l-.227-2.52-47.434-27.385 2.813 11.169c1.658 6.589 1.377 19.255.705 29.629-5.886-8.955-12.632-20.21-14.377-26.768-1.438-5.41-.183-11.228 1.125-15.156l1.252-3.774-23.769-13.721 1.084 9.6c.115.986.171 2.092.19 3.252-1.809-3.11-3.269-6.011-3.777-7.91-.188-.708-.222-1.802-.249-2.678a35 35 0 0 0-.073-1.504l-.224-2.523-8-4.617a17 17 0 0 1-.999-.668c-.72-.51-1.621-1.143-2.72-1.653-.85-.383-1.484-.786-1.987-1.249-1.484-1.466-2.954-2.957-4.426-4.447l-1.206-1.224c-.676-.715-1.36-1.422-2.043-2.133-1.223-1.271-2.38-2.473-3.526-3.728-.567-.608-1.113-1.2-1.646-1.779q1.21.271 2.309.526c1.621.354 3.154.74 4.776 1.148 1.04.264 2.08.526 3.125.776 2.092.548 4.17 1.121 6.25 1.693l1.411.388c.166.077.662.46.991.715q.446.348.899.68c.754.531 1.45.841 1.995 1.063l.278.641 10.005 5.781 2.62-2.219c1.03-.874 2.007-1.391 3.257-1.73.957-.26 3.332-.692 8.481-.692h.274a66 66 0 0 1-3.867 2.164l-7.984 4.082 23.491 13.561 2.622-3.208c3.997-4.879 8.242-7.876 12.981-9.155 2.376-.641 7.171-1.406 16.536-1.406 4.712 0 9.565.195 13.848.442-8.359 5.592-18.745 11.95-25.4 14.175-3.88 1.938-12.654 4.639-12.654 4.639l48.54 27.119 2.617-2.222c1.032-.874 2.004-1.394 3.259-1.731.952-.256 3.325-.688 8.472-.688h.283a66 66 0 0 1-3.87 2.163l-7.981 4.082 25.078 14.478 2.617-2.217c1.035-.874 2.009-1.394 3.262-1.731.952-.256 3.325-.691 8.472-.691h.283a70 70 0 0 1-3.87 2.166l-8.049 4.114 7.861 4.468 22.603 13.049 1.04-1.453 8.689 8.821c.564.593 1.189 1.243 1.814 1.894a242 242 0 0 1 3.74 3.945l1.409 1.516q-.97-.22-1.974-.454" fill="currentColor"/>
  <path d="m251.009 264.932 6.089-4.918-11.958-2.893a16 16 0 0 0-2.19-1.523 12 12 0 0 0-.466-1.718c.268-.411.532-.844.791-1.317a16 16 0 0 0 2.29-1.607l11.621-1.922-5.801-5.909q.469-.981.852-1.926c1.638-4.044 7.771-10.678 7.771-10.678s-8.813 1.992-13.135 1.392a32 32 0 0 0-2.207-.235l-1.216-7.734-8.484 8.91a16.3 16.3 0 0 0-2.415 1.136 12 12 0 0 0-1.721-.454 19 19 0 0 0-.745-1.345c0-.948-.088-1.878-.249-2.787l4.148-11.024-8.02 2.068a34 34 0 0 0-1.24-1.698c-2.681-3.441-5.364-12.069-5.364-12.069s-2.681 8.628-5.361 12.069c-.44.564-.881 1.164-1.309 1.795l-7.302-2.814 3.471 11.803a16 16 0 0 0-.222 2.658c-.476.408-.881.833-1.253 1.263-.493-.028-1.001-.042-1.538-.028a16.3 16.3 0 0 0-2.539-1.181l-7.474-9.101-2.219 7.979c-.719.055-1.419.131-2.091.227-4.321.599-13.133-1.392-13.133-1.392s6.13 6.636 7.77 10.68q.402.996.902 2.03l-6.091 4.917 11.959 2.894c.68.558 1.408 1.07 2.191 1.523.115.613.281 1.178.467 1.714-.268.414-.534.847-.793 1.318a16 16 0 0 0-2.292 1.609l-11.618 1.92 5.799 5.912c-.313.65-.596 1.297-.85 1.924-1.639 4.044-7.77 10.68-7.77 10.68s8.811-1.992 13.132-1.391c.708.099 1.448.181 2.209.235l1.212 7.732 8.485-8.91a16 16 0 0 0 2.414-1.135c.591.209 1.162.346 1.721.456.222.438.461.885.745 1.345 0 .945.088 1.877.249 2.787l-4.148 11.024 8.02-2.068c.408.596.825 1.164 1.24 1.699 2.68 3.44 5.361 12.068 5.361 12.068s2.683-8.628 5.364-12.068q.664-.85 1.309-1.797l7.302 2.815-3.471-11.803c.144-.868.222-1.757.222-2.658.476-.408.882-.832 1.253-1.266.493.028 1.001.042 1.538.031.821.474 1.67.863 2.539 1.178l7.473 9.105 2.219-7.982a35 35 0 0 0 2.092-.224c4.321-.603 13.132 1.389 13.132 1.389s-6.133-6.636-7.771-10.677a30 30 0 0 0-.896-2.033m-32.3-6.26a5.525 5.525 0 1 1 .005-11.045 5.525 5.525 0 0 1-.005 11.045" fill="currentColor"/>
</svg>
`,
`<svg viewBox="0 0 488 563" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M310.307 110.261c11.873-7.288 15.183-23.473 15.183-23.473s-15.932-4.365-27.8 2.922c-5.945 3.653-9.744 9.533-12.056 14.495l-17.231-1.671-.459-9.298c4.504-.64 9.675-2.042 14.419-4.956 11.873-7.287 16.546-21.255 16.546-21.255s-14.57-2.148-26.441 5.14c-2.903 1.781-5.369 3.963-7.446 6.239l-13.167-3.284-1.567-3.125c2.131.172 8.193.321 13.318-2.826 6.333-3.888 8.828-11.34 8.828-11.34s-7.774-1.147-14.107 2.743c-5.047 3.099-7.651 8.45-8.503 10.5l-1.27-2.533s.469-5.741.828-13.924c.918-.171 1.919-.487 2.849-1.058 2.72-1.67 3.792-4.872 3.792-4.872s-3.34-.493-6.059 1.179a6 6 0 0 0-.405.273c.112-3.438.198-7.151.215-10.956.806-.185 1.658-.486 2.458-.977 2.72-1.671 3.792-4.872 3.792-4.872s-3.34-.493-6.059 1.178c-.071.043-.134.09-.2.135a231 231 0 0 0-.291-9.657c.894-.175 1.86-.488 2.759-1.041 2.72-1.67 3.792-4.872 3.792-4.872s-3.34-.492-6.059 1.179c-.271.166-.52.35-.762.544-.764-9.772-2.407-17.958-5.603-20.798-3.176 2.822-4.819 10.925-5.591 20.614a7 7 0 0 0-.53-.36c-2.719-1.671-6.06-1.179-6.06-1.179s1.072 3.202 3.794 4.872c.815.503 1.689.808 2.512.991a229 229 0 0 0-.288 9.547c-2.712-1.639-6.018-1.153-6.018-1.153s1.072 3.201 3.794 4.872a8 8 0 0 0 2.209.917c.017 3.763.098 7.437.212 10.846q-.077-.053-.156-.104c-2.719-1.672-6.06-1.179-6.06-1.179s1.072 3.202 3.794 4.872c.845.52 1.753.83 2.598 1.011.359 8.208.833 13.971.833 13.971l-1.138 2.267c-.957-2.217-3.547-7.261-8.391-10.234-6.333-3.89-14.106-2.743-14.106-2.743s2.495 7.452 8.828 11.34c4.944 3.036 10.745 3.003 13.064 2.843l-1.557 3.108-12.967 3.233c-2.068-2.26-4.521-4.42-7.4-6.189-11.873-7.289-26.441-5.14-26.441-5.14s4.673 13.967 16.543 21.255c4.658 2.862 9.729 4.265 14.175 4.918l-.461 9.336-16.995 1.648c-2.312-4.957-6.109-10.827-12.044-14.472-11.87-7.287-27.803-2.922-27.803-2.922s3.31 16.185 15.185 23.473c5.996 3.684 13.025 4.39 18.518 4.188l-1.311 24.721c-1.408-2.385-3.645-5.32-6.899-7.319-6.333-3.891-14.106-2.743-14.106-2.743s2.493 7.451 8.828 11.34c4.844 2.976 10.523 3.004 12.927 2.853l6.927 19.622c-9.8 6.991-14.248 17.991-14.248 17.991s9.888 2.074 20.269-.935l3.862 10.95c-8.281 6.941-12.068 16.304-12.068 16.304s8.328 1.748 17.72-.29L243.6 280.73l26.06-73.84c9.487 2.118 17.952.342 17.952.342s-3.845-9.507-12.261-16.464l3.831-10.855c10.461 3.106 20.493 1 20.493 1s-4.507-11.149-14.446-18.135l6.88-19.493c2.246.165 8.152.245 13.169-2.837 6.335-3.889 8.828-11.34 8.828-11.34s-7.773-1.148-14.106 2.743c-3.435 2.109-5.733 5.263-7.124 7.71l-1.333-25.122c5.522.231 12.678-.439 18.764-4.178m-65.984 33.216-.046 25.036 33.682-26.135-33.691 31.62-.03 15.079-.015 10.507 23.865-16.998-23.872 22.481-.012 8.182c-.498 8.055-1.004 16.112-1.704 24.167-.667-8.059-1.142-16.115-1.611-24.175l.022-8.54-20.708-19.191 20.72 13.707.024-10.145.027-14.345-30.273-28.694 30.286 23.212.046-25.773-44.224-34.722 44.233 29.238.083-42.859-26.037-12.333 26.047 6.85.042-21.43c.569-8.057 1.009-16.112 1.69-24.167.652 8.058 1.059 16.116 1.599 24.174l-.039 21.43 32.434-8.319-32.446 13.802-.081 42.858 47.148-30.342z" fill="currentColor"/>
  <path d="M128.84 138.024c-.376-13.926-12.734-24.886-12.734-24.886s-11.75 11.615-11.372 25.539c.19 6.973 3.384 13.203 6.526 17.685l-10.063 14.088-8.283-4.252c1.7-4.219 3.071-9.401 2.917-14.965-.376-13.924-10.132-24.956-10.132-24.956s-9.148 11.544-8.769 25.469c.093 3.402.747 6.63 1.68 9.566l-9.429 9.761-3.489-.204c1.214-1.759 4.375-6.936 4.212-12.948-.198-7.429-5.405-13.315-5.405-13.315s-4.88 6.16-4.68 13.589c.161 5.922 3.494 10.851 4.844 12.614l-2.829-.166s-4.736-3.278-11.643-7.679c.31-.879.537-1.904.508-2.996-.088-3.191-2.322-5.72-2.322-5.72s-2.097 2.647-2.012 5.838q.012.247.034.49a383 383 0 0 0-9.38-5.665c.244-.791.41-1.68.383-2.617-.088-3.191-2.324-5.72-2.324-5.72s-2.095 2.646-2.007 5.837c0 .081.01.161.015.242a232 232 0 0 0-8.506-4.579c.296-.859.505-1.853.476-2.908-.088-3.192-2.324-5.721-2.324-5.721s-2.095 2.647-2.007 5.839c.007.319.044.628.09.932C11.97 141.992 4.06 139.323 0 140.67c.857 4.161 7.053 9.636 15.058 15.148a7 7 0 0 0-.576.278c-2.807 1.52-4.05 4.659-4.05 4.659s3.308.671 6.113-.85c.845-.456 1.548-1.061 2.117-1.681a226 226 0 0 0 8.122 5.023c-2.776 1.531-4.006 4.634-4.006 4.634s3.308.674 6.113-.847a8 8 0 0 0 1.9-1.458 379 379 0 0 0 9.499 5.24c-.054.027-.112.051-.168.083-2.808 1.518-4.05 4.657-4.05 4.657s3.311.674 6.116-.847c.874-.471 1.596-1.102 2.178-1.745 7.285 3.794 12.515 6.264 12.515 6.264l1.392 2.118c-2.397-.282-8.062-.556-13.059 2.148-6.533 3.541-9.429 10.847-9.429 10.847s7.703 1.566 14.236-1.977c5.1-2.761 7.974-7.803 8.997-9.891l1.909 2.904-3.682 12.845c-2.99.663-6.086 1.705-9.06 3.314-12.246 6.635-17.671 20.328-17.671 20.328s14.431 2.934 26.68-3.7c4.807-2.604 8.557-6.294 11.348-9.818l7.854 5.067-7.073 15.543c-5.449-.475-12.429-.123-18.555 3.195-12.246 6.635-16.431 22.617-16.431 22.617s15.672 5.224 27.92-1.413c6.19-3.353 10.315-9.088 12.886-13.945l20.755 13.496c-2.77.028-6.43.496-9.788 2.315-6.536 3.54-9.43 10.846-9.43 10.846s7.702 1.566 14.235-1.975c5.002-2.707 7.864-7.611 8.936-9.77l20.454 3.815c1.155 11.981 8.457 21.336 8.457 21.336s6.738-7.527 9.324-18.021l11.416 2.128c1.87 10.644 8.083 18.605 8.083 18.605s5.678-6.339 8.608-15.492l76.929 14.34-50.921-59.49c6.577-7.156 9.273-15.374 9.273-15.374s-10.156-1.424-20.388 2.384l-7.485-8.745c7.92-7.506 11.113-17.244 11.113-17.244s-11.911-1.674-22.927 3.44l-13.445-15.706c1.267-1.86 4.289-6.937 4.128-12.822-.198-7.43-5.405-13.317-5.405-13.317s-4.88 6.16-4.678 13.59c.11 4.03 1.689 7.596 3.113 10.025l-22.422-11.406c2.959-4.673 5.955-11.201 5.762-18.344m-4.227 73.754 21.658 12.558-5.793-42.239 10.537 44.989 13.045 7.565 9.092 5.263-2.786-29.164 7.532 31.915 7.08 4.098c6.726 4.459 13.452 8.924 20.078 13.56-7.314-3.451-14.529-7.069-21.741-10.692l-7.385-4.287-26.975 8.338 22.229-11.09-8.775-5.095-12.41-7.196-39.983 11.874 35.242-14.624-22.295-12.927-52.183 20.937 47.439-23.688-37.077-21.498-23.699 16.382 18.958-19.134-18.54-10.749c-6.692-4.523-13.445-8.929-20.083-13.549 7.305 3.465 14.487 7.14 21.736 10.702l18.537 10.75 9.014-32.25-4.27 35.001 37.075 21.499-2.703-56.002z" fill="currentColor"/>
  <path d="M62.15 309.06c-12.249-6.635-27.922-1.412-27.922-1.412s4.187 15.983 16.433 22.618c6.133 3.32 13.128 3.669 18.58 3.189l7.169 15.761-7.825 5.047c-2.805-3.581-6.606-7.358-11.499-10.012-12.249-6.633-26.682-3.699-26.682-3.699s5.427 13.694 17.673 20.33c2.993 1.621 6.113 2.666 9.126 3.325l3.74 13.047-1.924 2.92c-.916-1.931-3.818-7.256-9.106-10.122-6.536-3.54-14.236-1.973-14.236-1.973s2.893 7.305 9.43 10.845c5.207 2.822 11.142 2.397 13.344 2.112l-1.555 2.366s-5.21 2.466-12.473 6.245c-.61-.708-1.382-1.416-2.341-1.939-2.807-1.518-6.116-.847-6.116-.847s1.245 3.137 4.05 4.661q.22.114.44.212a390 390 0 0 0-9.593 5.291 8.3 8.3 0 0 0-2.075-1.641c-2.81-1.519-6.118-.845-6.118-.845s1.245 3.135 4.05 4.658c.073.039.146.068.22.103a236 236 0 0 0-8.22 5.08c-.598-.686-1.35-1.365-2.278-1.868-2.808-1.518-6.118-.847-6.118-.847s1.245 3.137 4.05 4.658c.281.154.567.276.854.388C7.147 412.258.88 417.776.018 421.962c4.031 1.34 11.87-1.287 20.647-5.466q-.037.314-.049.64c-.086 3.188 2.012 5.835 2.012 5.835s2.236-2.527 2.322-5.718c.027-.962-.146-1.87-.398-2.673a226 226 0 0 0 8.413-4.524c-.066 3.169 2.007 5.791 2.007 5.791s2.239-2.532 2.324-5.723a8 8 0 0 0-.313-2.373 383 383 0 0 0 9.287-5.605c-.003.061-.01.122-.012.185-.088 3.191 2.01 5.835 2.01 5.835s2.236-2.527 2.324-5.718c.027-.993-.156-1.933-.425-2.759 6.93-4.411 11.685-7.705 11.685-7.705l2.53-.146c-1.444 1.936-4.515 6.701-4.669 12.383-.203 7.429 4.678 13.589 4.678 13.589s5.208-5.886 5.408-13.315c.156-5.798-2.773-10.808-4.07-12.737l3.469-.202 9.287 9.614c-.923 2.92-1.57 6.123-1.663 9.502-.376 13.923 8.77 25.469 8.77 25.469s9.76-11.03 10.134-24.956c.15-5.464-1.172-10.559-2.827-14.736l8.315-4.27 9.927 13.896c-3.137 4.48-6.323 10.703-6.511 17.666-.379 13.923 11.37 25.539 11.37 25.539s12.359-10.962 12.734-24.887c.193-7.034-2.71-13.477-5.632-18.13l22.065-11.225c-1.362 2.412-2.786 5.815-2.891 9.631-.2 7.429 4.678 13.591 4.678 13.591s5.207-5.889 5.41-13.315c.154-5.686-2.664-10.615-3.997-12.622l13.53-15.808c10.955 4.99 22.708 3.342 22.708 3.342s-3.149-9.599-10.945-17.085l7.549-8.821c10.154 3.701 20.156 2.302 20.156 2.302s-2.654-8.089-9.114-15.205l50.881-59.447-76.978 14.349c-2.91-9.275-8.679-15.714-8.679-15.714s-6.308 8.082-8.127 18.848l-11.316 2.109c-2.542-10.613-9.38-18.246-9.38-18.246s-7.405 9.478-8.481 21.576l-20.325 3.789c-.979-2.026-3.865-7.184-9.038-9.988-6.538-3.54-14.239-1.972-14.239-1.972s2.893 7.306 9.431 10.844c3.543 1.924 7.424 2.336 10.239 2.314l-21.09 13.716c-2.562-4.903-6.717-10.762-12.999-14.166m61.758 40.538 21.704-12.476-39.473-16.103 44.226 13.369 13.074-7.515 9.109-5.242-26.653-12.168 31.404 9.436 7.092-4.082c7.227-3.599 14.453-7.189 21.78-10.611-6.646 4.607-13.386 9.048-20.13 13.484l-7.407 4.25-6.264 27.529 1.511-24.8-8.801 5.054-12.434 7.148-9.712 40.567 4.956-37.832-22.341 12.842-7.959 55.662 3.203-52.927-37.156 21.357 2.336 28.718-7.09-25.986-18.582 10.681c-7.258 3.535-14.455 7.182-21.772 10.62 6.653-4.595 13.426-8.977 20.135-13.472l18.579-10.681-23.421-23.931 28.174 21.199 37.158-21.36-49.85-25.659z" fill="currentColor"/>
  <path d="M176.928 452.337c-11.873 7.287-15.183 23.472-15.183 23.472s15.932 4.368 27.803-2.922c5.94-3.65 9.739-9.534 12.051-14.495l17.234 1.67.459 9.3c-4.502.642-9.675 2.043-14.419 4.956-11.87 7.287-16.546 21.255-16.546 21.255s14.57 2.148 26.441-5.139c2.9-1.782 5.366-3.962 7.446-6.24l13.167 3.286 1.567 3.125c-2.131-.173-8.193-.324-13.32 2.822-6.333 3.889-8.828 11.343-8.828 11.343s7.776 1.147 14.109-2.744c5.049-3.1 7.649-8.45 8.503-10.498l1.27 2.529s-.471 5.742-.83 13.926c-.916.171-1.917.484-2.847 1.055-2.72 1.675-3.792 4.875-3.792 4.875s3.34.491 6.059-1.179a8 8 0 0 0 .405-.273 380 380 0 0 0-.215 10.957c-.808.183-1.66.484-2.458.977-2.72 1.67-3.792 4.87-3.792 4.87s3.34.491 6.059-1.179c.068-.044.134-.093.2-.137.034 3.247.125 6.504.288 9.658-.893.176-1.855.488-2.756 1.04-2.72 1.672-3.792 4.873-3.792 4.873s3.34.493 6.059-1.179q.405-.25.762-.545c.764 9.771 2.407 17.959 5.603 20.798 3.174-2.822 4.822-10.925 5.591-20.613q.252.187.527.359c2.72 1.672 6.059 1.179 6.059 1.179s-1.069-3.201-3.791-4.873c-.818-.503-1.692-.805-2.512-.989.164-3.117.251-6.335.29-9.548 2.71 1.641 6.016 1.155 6.016 1.155s-1.072-3.201-3.794-4.87a8 8 0 0 0-2.21-.918 374 374 0 0 0-.212-10.847q.075.055.154.105c2.72 1.67 6.059 1.179 6.059 1.179s-1.069-3.201-3.791-4.875c-.845-.518-1.751-.828-2.6-1.008-.356-8.206-.83-13.972-.83-13.972l1.138-2.266c.955 2.217 3.547 7.261 8.389 10.234 6.333 3.891 14.109 2.742 14.109 2.742s-2.495-7.451-8.831-11.341c-4.941-3.034-10.742-3-13.064-2.842l1.56-3.108 12.969-3.232c2.066 2.258 4.519 4.421 7.4 6.189 11.868 7.288 26.44 5.139 26.44 5.139s-4.675-13.967-16.545-21.255c-4.658-2.859-9.732-4.265-14.175-4.919l.459-9.336 16.997-1.648c2.312 4.958 6.109 10.828 12.044 14.473 11.868 7.29 27.803 2.922 27.803 2.922s-3.313-16.184-15.185-23.472c-5.996-3.684-13.028-4.39-18.518-4.189l1.311-24.719c1.408 2.385 3.645 5.32 6.897 7.317 6.333 3.891 14.109 2.744 14.109 2.744s-2.495-7.451-8.828-11.343c-4.846-2.974-10.523-3.001-12.927-2.849l-6.927-19.622c9.8-6.992 14.25-17.993 14.25-17.993s-9.887-2.073-20.271.938l-3.862-10.952c8.279-6.939 12.07-16.304 12.07-16.304s-8.33-1.746-17.722.293l-26.045-73.79-26.06 73.839c-9.487-2.115-17.952-.342-17.952-.342s3.845 9.507 12.261 16.465l-3.833 10.854c-10.462-3.105-20.491-1.001-20.491-1.001s4.507 11.152 14.443 18.135l-6.877 19.495c-2.246-.163-8.154-.244-13.172 2.835-6.333 3.892-8.828 11.343-8.828 11.343s7.776 1.147 14.109-2.744c3.435-2.109 5.735-5.261 7.124-7.707l1.333 25.119c-5.525-.232-12.676.437-18.765 4.177m65.984-33.218.046-25.034-33.679 26.135 33.689-31.619.03-15.081.015-10.508-23.865 16.999 23.875-22.48.01-8.183c.496-8.057 1.001-16.111 1.702-24.168.669 8.059 1.145 16.118 1.611 24.175l-.02 8.54 20.705 19.192-20.718-13.708-.024 10.149-.027 14.341 30.273 28.696-30.286-23.21-.046 25.769 44.224 34.724-44.236-29.238-.081 42.859 26.037 12.331-26.047-6.85-.042 21.428c-.569 8.057-1.009 16.113-1.692 24.17-.65-8.057-1.059-16.118-1.597-24.175l.039-21.431-32.437 8.32 32.446-13.801.083-42.859-47.148 30.342z" fill="currentColor"/>
  <path d="M358.393 424.573c.378 13.926 12.737 24.883 12.737 24.883s11.748-11.612 11.372-25.537c-.19-6.973-3.384-13.203-6.528-17.686l10.064-14.087 8.286 4.25c-1.699 4.219-3.071 9.402-2.92 14.966.378 13.924 10.134 24.954 10.134 24.954s9.148-11.543 8.769-25.466c-.09-3.403-.747-6.629-1.68-9.568l9.429-9.761 3.489.205c-1.216 1.758-4.378 6.934-4.214 12.949.2 7.427 5.41 13.315 5.41 13.315s4.878-6.162 4.678-13.589c-.161-5.923-3.496-10.852-4.844-12.617l2.829.166s4.734 3.281 11.643 7.681c-.31.881-.54 1.904-.51 2.998.09 3.189 2.324 5.718 2.324 5.718s2.097-2.647 2.009-5.838a8 8 0 0 0-.032-.491 371 371 0 0 0 9.38 5.667c-.244.791-.41 1.682-.386 2.62.088 3.188 2.324 5.718 2.324 5.718s2.097-2.646 2.009-5.838c-.002-.08-.01-.163-.017-.241a233 233 0 0 0 8.508 4.58c-.296.859-.505 1.85-.476 2.905.086 3.193 2.322 5.723 2.322 5.723s2.099-2.646 2.012-5.838a8 8 0 0 0-.093-.932c8.843 4.226 16.755 6.892 20.813 5.547-.854-4.163-7.051-9.639-15.059-15.149.196-.083.386-.176.581-.278 2.803-1.519 4.046-4.658 4.046-4.658s-3.303-.674-6.113.85a8.1 8.1 0 0 0-2.114 1.679 231 231 0 0 0-8.125-5.024c2.778-1.528 4.009-4.634 4.009-4.634s-3.308-.674-6.113.849a8 8 0 0 0-1.902 1.455 382 382 0 0 0-9.499-5.239c.056-.027.115-.051.168-.08 2.808-1.521 4.051-4.661 4.051-4.661s-3.306-.674-6.116.849c-.872.469-1.594 1.101-2.175 1.743-7.285-3.789-12.515-6.265-12.515-6.265l-1.392-2.117c2.397.281 8.059.557 13.057-2.146 6.538-3.545 9.429-10.849 9.429-10.849s-7.7-1.568-14.236 1.978c-5.098 2.761-7.974 7.803-8.994 9.892l-1.909-2.905 3.682-12.849c2.991-.657 6.087-1.702 9.06-3.313 12.246-6.633 17.671-20.327 17.671-20.327s-14.434-2.935-26.68 3.701c-4.805 2.602-8.555 6.294-11.348 9.817l-7.854-5.066 7.07-15.544c5.449.476 12.429.124 18.555-3.196 12.248-6.633 16.431-22.616 16.431-22.616s-15.669-5.224-27.917 1.415c-6.189 3.352-10.318 9.087-12.886 13.945l-20.755-13.496c2.769-.027 6.431-.498 9.788-2.316 6.536-3.54 9.429-10.846 9.429-10.846s-7.7-1.565-14.234 1.974c-5.003 2.71-7.864 7.615-8.936 9.772l-20.454-3.812c-1.157-11.984-8.459-21.338-8.459-21.338s-6.739 7.527-9.324 18.021l-11.414-2.128c-1.87-10.642-8.083-18.605-8.083-18.605s-5.676 6.34-8.608 15.492l-76.929-14.339 50.918 59.49c-6.575 7.158-9.27 15.373-9.27 15.373s10.156 1.426 20.388-2.383l7.485 8.74c-7.92 7.51-11.113 17.246-11.113 17.246s11.911 1.675 22.927-3.438l13.442 15.703c-1.265 1.863-4.287 6.938-4.128 12.825.2 7.429 5.407 13.318 5.407 13.318s4.88-6.162 4.678-13.589c-.11-4.033-1.689-7.6-3.113-10.029l22.422 11.406c-2.963 4.675-5.961 11.203-5.768 18.346m4.229-73.754-21.658-12.556 5.793 42.236-10.54-44.988-13.042-7.564-9.094-5.266 2.791 29.163-7.534-31.914-7.08-4.097c-6.726-4.46-13.45-8.926-20.078-13.561 7.314 3.451 14.529 7.069 21.741 10.692l7.385 4.287 26.973-8.337-22.229 11.089 8.777 5.098 12.407 7.195 39.985-11.872-35.242 14.624 22.295 12.925 52.183-20.935-47.439 23.689 37.075 21.496 23.701-16.382-18.958 19.133 18.538 10.752c6.692 4.521 13.449 8.926 20.083 13.545-7.302-3.462-14.485-7.138-21.734-10.7l-18.54-10.75-9.011 32.251 4.27-35.002-37.075-21.499 2.703 56.003z" fill="currentColor"/>
  <path d="M425.085 253.536c12.249 6.636 27.92 1.412 27.92 1.412s-4.182-15.982-16.433-22.617c-6.13-3.32-13.127-3.671-18.576-3.191l-7.171-15.759 7.825-5.048c2.803 3.579 6.604 7.36 11.501 10.011 12.246 6.635 26.677 3.7 26.677 3.7s-5.425-13.693-17.671-20.327c-2.993-1.623-6.113-2.668-9.126-3.329l-3.74-13.046 1.924-2.918c.916 1.93 3.816 7.256 9.106 10.121 6.533 3.542 14.236 1.976 14.236 1.976s-2.893-7.306-9.429-10.848c-5.21-2.821-11.145-2.399-13.347-2.112l1.56-2.365s5.205-2.462 12.473-6.245c.606.709 1.377 1.417 2.339 1.938 2.808 1.518 6.113.847 6.113.847s-1.243-3.141-4.048-4.657c-.146-.08-.295-.15-.439-.219a384 384 0 0 0 9.593-5.289c.564.606 1.252 1.196 2.078 1.642 2.805 1.521 6.116.847 6.116.847s-1.243-3.139-4.053-4.66c-.071-.039-.146-.069-.217-.105a234 234 0 0 0 8.22-5.079c.598.685 1.35 1.365 2.278 1.866 2.808 1.52 6.116.849 6.116.849s-1.243-3.14-4.05-4.658a8 8 0 0 0-.854-.388c8.081-5.546 14.35-11.063 15.213-15.25-4.031-1.339-11.87 1.287-20.647 5.466q.035-.314.049-.641c.086-3.19-2.012-5.835-2.012-5.835s-2.236 2.527-2.324 5.72c-.024.96.149 1.868.403 2.671a229 229 0 0 0-8.416 4.524c.063-3.169-2.009-5.789-2.009-5.789s-2.236 2.529-2.322 5.72c-.024.844.11 1.646.313 2.374a361 361 0 0 0-9.287 5.607c.003-.063.01-.125.012-.187.085-3.191-2.012-5.838-2.012-5.838s-2.236 2.527-2.322 5.72c-.03.992.156 1.933.425 2.756-6.929 4.413-11.684 7.706-11.684 7.706l-2.53.148c1.44-1.937 4.512-6.703 4.671-12.384.2-7.43-4.682-13.588-4.682-13.588s-5.205 5.885-5.406 13.315c-.159 5.797 2.771 10.808 4.07 12.736l-3.472.204-9.285-9.615c.926-2.918 1.57-6.122 1.66-9.501.376-13.923-8.77-25.469-8.77-25.469s-9.758 11.031-10.134 24.956c-.149 5.463 1.174 10.558 2.827 14.736l-8.313 4.269-9.927-13.896c3.137-4.48 6.321-10.702 6.511-17.666.379-13.923-11.37-25.537-11.37-25.537s-12.361 10.958-12.737 24.885c-.19 7.035 2.712 13.478 5.632 18.131l-22.063 11.225c1.362-2.412 2.786-5.815 2.888-9.632.205-7.43-4.678-13.59-4.678-13.59s-5.205 5.886-5.408 13.315c-.154 5.686 2.661 10.618 3.994 12.622l-13.528 15.807c-10.957-4.99-22.708-3.342-22.708-3.342s3.149 9.6 10.945 17.085l-7.551 8.821c-10.149-3.701-20.154-2.301-20.154-2.301s2.651 8.087 9.114 15.203l-50.881 59.451 76.978-14.353c2.91 9.274 8.677 15.718 8.677 15.718s6.313-8.084 8.13-18.849l11.314-2.111c2.544 10.613 9.382 18.248 9.382 18.248s7.402-9.481 8.484-21.578l20.322-3.789c.979 2.026 3.862 7.182 9.041 9.988 6.536 3.54 14.236 1.975 14.236 1.975s-2.893-7.309-9.431-10.846c-3.545-1.92-7.424-2.334-10.239-2.316l21.091-13.716c2.559 4.905 6.714 10.763 12.999 14.168m-61.758-40.54-21.706 12.479 39.475 16.101-44.229-13.367-13.071 7.512-9.109 5.243 26.653 12.168-31.404-9.435-7.092 4.082c-7.224 3.598-14.455 7.188-21.78 10.608 6.646-4.608 13.384-9.047 20.13-13.48l7.407-4.252 6.265-27.528-1.511 24.794 8.801-5.051 12.434-7.148 9.712-40.564-4.956 37.833 22.341-12.845 7.961-55.659-3.205 52.927 37.156-21.359-2.336-28.716 7.09 25.984 18.579-10.68c7.261-3.535 14.458-7.183 21.775-10.619-6.656 4.592-13.428 8.976-20.137 13.471l-18.577 10.68 23.421 23.93-28.176-21.199-37.156 21.36 49.851 25.659z" fill="currentColor"/>
</svg>
`,`<svg viewBox="0 0 506 583" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M482.096 413.661c-3.94-2.271-8.879-1.104-11.465 2.522l-18.797-11.944-2.131-11.699-11.16-4.502-.166-11.094-11.692-.991-.745-10.491 16.367 1.504-3.12-13.379.806-8.025 33.157 15.098-27.285-18.921 4.795-3.122c.561.505 1.182.967 1.863 1.357 5.303 3.066 12.088 1.245 15.149-4.058 1.638-2.837 1.839-6.084.903-8.965l4.507-2.937c.303.293.63.562 1.011.781a5.25 5.25 0 0 0 7.173-1.922c.811-1.404.876-3.012.366-4.424l6.133-3.999c.095.066.176.141.271.198a4.09 4.09 0 0 0 5.583-1.497c.51-.884.635-1.877.456-2.808l8.587-5.591-8.855 4.7a4.08 4.08 0 0 0-1.685-1.883 4.09 4.09 0 0 0-5.583 1.497 4.07 4.07 0 0 0 .093 4.199l-6.204 3.291a5.2 5.2 0 0 0-1.082-.862 5.26 5.26 0 0 0-7.178 1.922c-.661 1.147-.818 2.434-.583 3.638l-4.646 2.463a11.1 11.1 0 0 0-3.328-2.954c-5.305-3.061-12.088-1.243-15.151 4.063-1.667 2.896-1.841 6.216-.83 9.146l-4.807 2.554-6.206-37.19.022 40.473-9.929-1.216-8.616-30.224-4.231 28.086-3.972 17.59-10.51-55.901-6.768 44.47-25.178-24.136.356 23.342-15.269-6.189 14.253 14.551-38.269-24.322 30.281-23.156-49.985 10.635-19.717-12.532 15.713-8.614 14.89 3.008-11.541-4.846 6.621-3.63-9.287 2.51-15.974-6.709 20.232-12.744 56.108 18.989-36.355-31.436 34.438-21.687-11.348 11.577 15.273-6.191-.356 23.345 25.176-24.138 6.77 44.475 10.508-55.903 3.974 17.59 4.229 28.083 8.618-30.219 9.927-1.219-.022 40.476 6.204-37.192 3.213 1.702c-.559 2.595-.23 5.388 1.199 7.866 3.059 5.307 9.844 7.121 15.149 4.06.93-.535 1.711-1.218 2.419-1.958l6.033 3.205a5.2 5.2 0 0 0 .688 2.913 5.26 5.26 0 0 0 7.178 1.924c.191-.115.357-.254.525-.381l5.661 3.003a4.05 4.05 0 0 0 .422 2.993 4.09 4.09 0 0 0 5.583 1.499 4 4 0 0 0 .955-.796l10.815 5.74-10.181-6.626a4.06 4.06 0 0 0-.095-3.901 4.08 4.08 0 0 0-5.581-1.496 4 4 0 0 0-1.123.974l-4.919-3.208a5.22 5.22 0 0 0-.144-4.975 5.253 5.253 0 0 0-7.173-1.926 5.1 5.1 0 0 0-1.414 1.218l-5.085-3.316c1.382-3.127 1.338-6.841-.505-10.037-3.061-5.302-9.844-7.119-15.151-4.057-1.023.593-1.875 1.355-2.63 2.19l-2.798-1.824 27.287-18.916-33.159 15.1-.805-8.027 3.125-13.379L426 217.4l.747-10.498 11.692-.989.163-11.089 11.16-4.502 2.903-10.53 19.021-11.992c2.74 2.625 6.956 3.281 10.406 1.287 3.66-2.112 5.219-6.472 3.938-10.335l19.521-12.309-20.31 10.605c-2.441-4.124-7.744-5.527-11.904-3.13-3.938 2.278-5.396 7.141-3.55 11.192l-19.741 10.305-11.199-4.004-9.478 7.414-9.69-5.403-6.702 9.631-9.46-4.602 9.485-13.423-13.147-3.987-6.545-4.709 29.653-21.167-30.027 14.17-.308-5.713c.72-.234 1.428-.542 2.107-.935 5.305-3.059 7.121-9.844 4.06-15.151-1.638-2.832-4.348-4.629-7.312-5.264l-.288-5.371a5.2 5.2 0 0 0 1.179-.483 5.25 5.25 0 0 0 1.924-7.173c-.813-1.406-2.173-2.266-3.65-2.527l-.396-7.312c.105-.051.21-.083.305-.137a4.09 4.09 0 0 0 1.499-5.583c-.513-.886-1.311-1.487-2.207-1.802l-.547-10.227-.354 10.017a4.1 4.1 0 0 0-2.476.515 4.09 4.09 0 0 0-1.496 5.584 4.07 4.07 0 0 0 3.682 2.021l-.249 7.016a5.2 5.2 0 0 0-1.286.508 5.254 5.254 0 0 0-1.927 7.175 5.2 5.2 0 0 0 2.859 2.324l-.191 5.259a11 11 0 0 0-4.221 1.401c-5.305 3.064-7.119 9.849-4.06 15.152 1.675 2.896 4.465 4.704 7.51 5.293l-.193 5.442-35.313-13.22 35.061 20.215-6.016 7.993-30.483-7.651 22.209 17.708 13.247 12.236-53.667-18.85 35.13 28.096-33.491 9.736 20.393 11.362-12.995 10.132 19.729-5.071-40.2 20.982-4.912-37.803-15.783 48.606-20.711 10.811.398-17.917 10.049-11.389-9.966 7.571.168-7.549-2.471 9.299-13.799 10.479-.923-23.894 44.502-39.099-45.401 15.769-1.567-40.667 4.355 15.613 2.275-16.319 20.039 11.978-8.315-33.872 41.899 16.377-43.159-37.053 17.221 5.357 26.436 10.381-21.865-22.578 3.911-9.204 35.042 20.256-29.107-23.97 3.079-1.926c1.968 1.777 4.551 2.891 7.412 2.891 6.125 0 11.091-4.963 11.091-11.091 0-1.072-.2-2.09-.486-3.074l5.789-3.62a5.251 5.251 0 0 0 8.123-4.394c0-.22-.039-.435-.066-.649l5.432-3.396a4.06 4.06 0 0 0 2.805 1.125 4.084 4.084 0 0 0 4.084-4.085c0-.43-.083-.835-.208-1.223l10.379-6.494-10.83 5.503a4.07 4.07 0 0 0-3.425-1.872 4.087 4.087 0 0 0-4.087 4.087c0 .515.105 1.006.281 1.458l-5.237 2.659a5.25 5.25 0 0 0-9.636 2.888c0 .647.132 1.26.347 1.833l-5.412 2.749c-2.017-2.763-5.256-4.583-8.943-4.583-6.123 0-11.089 4.966-11.089 11.09 0 1.186.234 2.304.578 3.373l-2.976 1.511-2.739-33.093-3.504 36.267-7.351-3.313-10.027-9.395-6.883 14.927-8.716-5.89 4.988-10.62-9.521-5.692 1.682-11.914-7.666-7.776-.879-22.471c3.643-1.059 6.318-4.385 6.318-8.369 0-4.229-2.998-7.751-6.98-8.574L253.646 0l-.972 22.891c-4.79.054-8.657 3.943-8.657 8.745 0 4.551 3.477 8.245 7.913 8.672l-.945 22.246-9.068 7.698 1.68 11.914-9.52 5.691 4.989 10.62-8.717 5.891-6.884-14.927-10.024 9.395-7.354 3.313-3.502-36.267-2.741 33.093-5.102-2.59c.157-.74.244-1.506.244-2.295 0-6.123-4.966-11.089-11.09-11.089-3.274 0-6.187 1.446-8.215 3.701l-4.797-2.437c.102-.408.171-.828.171-1.265 0-2.9-2.352-5.254-5.253-5.254-1.619 0-3.047.747-4.011 1.899l-6.529-3.318c.01-.11.034-.22.034-.332a4.087 4.087 0 0 0-4.086-4.087 4.05 4.05 0 0 0-2.661 1.011l-9.133-4.64 8.5 5.316a4.06 4.06 0 0 0-.791 2.4 4.085 4.085 0 0 0 4.086 4.085c1.564 0 2.905-.884 3.591-2.175l5.951 3.723a5.3 5.3 0 0 0-.204 1.372 5.25 5.25 0 0 0 5.254 5.251 5.2 5.2 0 0 0 3.44-1.31l4.458 2.79a11.1 11.1 0 0 0-.893 4.358c0 6.128 4.966 11.091 11.09 11.091 3.345 0 6.306-1.511 8.34-3.855l4.616 2.891-29.107 23.97 35.041-20.256 3.911 9.204-21.866 22.578 26.438-10.381 17.22-5.357-43.158 37.053 41.897-16.377-8.315 33.872 20.039-11.978 2.275 16.319 5.471-19.622-1.929 45.305-35.19-14.646 34.199 37.971-.993 23.342-15.318-9.302-4.835-14.399 1.571 12.417-6.453-3.919 6.816 6.79 2.175 17.188-21.153-11.147-11.608-58.089-9.045 47.2-36.003-18.975 15.701 4.033-12.997-10.129 20.396-11.365-33.491-9.734 35.128-28.098-53.667 18.85 13.248-12.234 22.208-17.708-30.484 7.646-6.017-7.988 35.065-20.217-35.313 13.223-.13-3.633c2.527-.813 4.781-2.495 6.213-4.973 3.061-5.303 1.245-12.085-4.059-15.149-.93-.537-1.913-.869-2.906-1.116l-.242-6.824a5.2 5.2 0 0 0 2.178-2.055 5.253 5.253 0 0 0-1.923-7.175c-.191-.11-.394-.183-.593-.266l-.228-6.404a4.07 4.07 0 0 0 2.38-1.865 4.084 4.084 0 0 0-1.496-5.58 4 4 0 0 0-1.162-.433l-.436-12.234-.65 12.129a4.07 4.07 0 0 0-3.334 2.031 4.084 4.084 0 0 0 1.496 5.581c.444.259.921.413 1.402.486l-.315 5.864a5.25 5.25 0 0 0-4.241 2.612 5.254 5.254 0 0 0 1.923 7.178c.56.325 1.157.517 1.759.618l-.326 6.06c-3.401.364-6.595 2.263-8.438 5.454-3.063 5.303-1.245 12.088 4.06 15.149 1.024.591 2.112.947 3.211 1.184l-.18 3.335-30.027-14.175 29.656 21.167-6.548 4.709-13.147 3.987 9.485 13.425-9.459 4.602-6.704-9.631-9.688 5.403-9.477-7.415-10.569 2.752-19.897-10.476c.901-3.684-.64-7.663-4.091-9.656a8.755 8.755 0 0 0-10.914 1.76L.872 144.928l19.337 12.29c-2.349 4.175-.914 9.468 3.245 11.87 3.939 2.275 8.878 1.108 11.466-2.517l18.794 11.943 2.133 11.699 11.16 4.502.167 11.089 11.692.991.743 10.491-16.368-1.499 3.122 13.379-.805 8.022-33.159-15.1 27.288 18.921-4.795 3.123a11 11 0 0 0-1.863-1.355c-5.305-3.064-12.089-1.245-15.15 4.057-1.638 2.837-1.841 6.079-.903 8.965l-4.508 2.937a5 5 0 0 0-1.01-.784 5.254 5.254 0 0 0-7.175 1.926c-.809 1.401-.875 3.01-.363 4.421l-6.135 3.997c-.094-.066-.173-.137-.272-.198a4.09 4.09 0 0 0-5.581 1.497 4.05 4.05 0 0 0-.456 2.81l-8.587 5.589 8.856-4.7a4.03 4.03 0 0 0 1.682 1.882 4.083 4.083 0 0 0 5.583-1.496c.78-1.353.683-2.957-.089-4.194l6.199-3.291c.322.32.672.62 1.085.862a5.254 5.254 0 0 0 7.175-1.926c.662-1.143.821-2.432.586-3.633l4.645-2.469a11.1 11.1 0 0 0 3.329 2.957c5.304 3.062 12.086 1.245 15.149-4.063 1.671-2.896 1.844-6.216.833-9.148l4.808-2.554 6.206 37.193-.023-40.476 9.927 1.216 8.62 30.224 4.229-28.086 3.971-17.59 10.509 55.903 6.769-44.472 25.177 24.136-.357-23.343 15.272 6.192-14.258-14.551 38.27 24.321-30.278 23.154 49.983-10.632 19.718 12.532-15.712 8.616-14.889-3.013 11.539 4.846-6.621 3.63 9.286-2.507 15.977 6.709-20.233 12.747-56.108-18.992 36.355 31.433-34.438 21.692 11.345-11.577-15.271 6.186.355-23.342-25.176 24.136-6.769-44.473-10.51 55.906-3.971-17.593-4.23-28.086-8.618 30.225-9.927 1.216.022-40.476-6.206 37.195-3.211-1.706c.559-2.595.231-5.386-1.199-7.866-3.062-5.303-9.845-7.121-15.149-4.057-.93.537-1.711 1.218-2.421 1.955l-6.031-3.201a5.2 5.2 0 0 0-.69-2.915 5.253 5.253 0 0 0-7.175-1.924c-.192.115-.357.251-.527.383l-5.661-3.005a4.05 4.05 0 0 0-.424-2.996 4.09 4.09 0 0 0-5.581-1.497 4 4 0 0 0-.956.793l-10.814-5.74 10.181 6.626a4.082 4.082 0 0 0 5.675 5.398 3.9 3.9 0 0 0 1.122-.972l4.922 3.206a5.24 5.24 0 0 0 .142 4.981 5.253 5.253 0 0 0 7.175 1.924 5.2 5.2 0 0 0 1.414-1.216l5.086 3.313c-1.384 3.13-1.338 6.841.504 10.034 3.061 5.303 9.845 7.122 15.15 4.058 1.024-.589 1.877-1.355 2.632-2.19l2.796 1.824-27.288 18.921 33.158-15.103.806 8.025-3.121 13.379 16.368-1.499-.743 10.493-11.692.989-.167 11.089-11.161 4.502-2.899 10.53-19.021 11.997c-2.741-2.627-6.956-3.284-10.408-1.287-3.66 2.112-5.217 6.47-3.935 10.33L0 436.308l20.31-10.603c2.443 4.123 7.743 5.527 11.902 3.122 3.94-2.276 5.399-7.136 3.552-11.189l19.741-10.3 11.199 4.004 9.479-7.417 9.688 5.4 6.703-9.631 9.46 4.607-9.485 13.421 13.146 3.989 6.547 4.705-29.655 21.17 30.028-14.172.307 5.713c-.72.237-1.427.542-2.107.935-5.305 3.064-7.122 9.849-4.06 15.154 1.637 2.834 4.346 4.631 7.312 5.261l.289 5.371a5.2 5.2 0 0 0-1.18.484 5.257 5.257 0 0 0-1.923 7.178c.809 1.401 2.17 2.263 3.649 2.527l.394 7.309c-.102.051-.208.083-.306.137a4.087 4.087 0 0 0-1.496 5.581 4.05 4.05 0 0 0 2.205 1.802l.548 10.232.355-10.022a4.06 4.06 0 0 0 2.474-.515 4.086 4.086 0 0 0 1.495-5.581c-.782-1.355-2.221-2.071-3.68-2.021l.249-7.017a5.2 5.2 0 0 0 1.288-.508 5.253 5.253 0 0 0 1.923-7.175c-.662-1.145-1.697-1.926-2.855-2.327l.187-5.254c1.445-.173 2.88-.63 4.222-1.404 5.304-3.064 7.122-9.846 4.059-15.154-1.674-2.891-4.462-4.7-7.507-5.293l.193-5.442 35.314 13.225-35.065-20.22 6.017-7.988 30.483 7.646-22.207-17.708-13.25-12.234 53.668 18.852-35.13-28.101 33.491-9.734-20.394-11.365 12.996-10.127-19.729 5.071 40.199-20.981 4.915 37.798 15.781-48.601 20.713-10.811-.397 17.915-10.051 11.387 9.966-7.571-.166 7.549 2.47-9.295 13.801-10.483.921 23.894-44.501 39.099 45.399-15.769 1.565 40.672-4.353-15.618-2.275 16.323-20.039-11.983 8.315 33.872-41.898-16.372 43.158 37.051-17.22-5.356-26.437-10.381 21.863 22.578-3.907 9.207-35.042-20.261 29.107 23.972-3.08 1.929c-1.968-1.782-4.552-2.895-7.413-2.895-6.125 0-11.09 4.966-11.09 11.091 0 1.077.201 2.092.486 3.074l-5.791 3.626a5.17 5.17 0 0 0-2.866-.862 5.255 5.255 0 0 0-5.255 5.251c.002.225.042.435.068.65l-5.433 3.401a4.05 4.05 0 0 0-2.804-1.13 4.09 4.09 0 0 0-4.088 4.085c0 .43.087.835.21 1.223l-10.38 6.497 10.828-5.503a4.1 4.1 0 0 0 3.43 1.87 4.086 4.086 0 0 0 4.086-4.087 4 4 0 0 0-.281-1.458l5.237-2.659a5.248 5.248 0 0 0 9.636-2.888 5.2 5.2 0 0 0-.349-1.831l5.415-2.747c2.018 2.764 5.255 4.578 8.942 4.578 6.124 0 11.09-4.966 11.09-11.089 0-1.182-.234-2.302-.579-3.374l2.975-1.511 2.74 33.093 3.502-36.265 7.354 3.313 10.026 9.394 6.883-14.929 8.717 5.891-4.99 10.62 9.521 5.691-1.682 11.916 7.669 7.774.877 22.473c-3.643 1.062-6.321 4.382-6.316 8.366a8.76 8.76 0 0 0 6.978 8.579l.901 23.059.974-22.891c4.79-.056 8.657-3.941 8.657-8.748 0-4.546-3.481-8.24-7.915-8.669l.947-22.246 9.068-7.698-1.685-11.916 9.521-5.691-4.988-10.62 8.718-5.886 6.88 14.924 10.027-9.394 7.351-3.313 3.506 36.265 2.739-33.093 5.102 2.59a11 11 0 0 0-.244 2.295c-.003 6.123 4.966 11.089 11.091 11.089 3.274 0 6.184-1.445 8.215-3.696l4.797 2.434a5 5 0 0 0-.173 1.262 5.25 5.25 0 0 0 5.251 5.254c1.621 0 3.047-.747 4.014-1.897l6.531 3.316c-.01.115-.034.22-.034.332a4.083 4.083 0 0 0 4.084 4.087 4.05 4.05 0 0 0 2.661-1.008l9.133 4.641-8.499-5.32a4.07 4.07 0 0 0 .791-2.4 4.086 4.086 0 0 0-4.087-4.085c-1.565 0-2.905.884-3.591 2.175l-5.952-3.721c.12-.444.203-.896.205-1.375 0-2.9-2.356-5.251-5.254-5.251a5.2 5.2 0 0 0-3.44 1.313l-4.46-2.79c.576-1.343.896-2.81.896-4.36 0-6.125-4.966-11.091-11.091-11.091-3.342 0-6.304 1.516-8.337 3.855l-4.617-2.888 29.106-23.972-35.042 20.261-3.909-9.207 21.865-22.578-26.438 10.381-17.219 5.356 43.154-37.056L278.32 438.1l8.313-33.872-20.037 11.978-2.275-16.313-5.474 19.617 1.929-45.305 35.193 14.649-34.199-37.974.991-23.342 15.32 9.302 4.837 14.402-1.572-12.417 6.453 3.916-6.816-6.785-2.175-17.19 21.155 11.147 11.606 58.086 9.046-47.2 36.001 18.977-15.701-4.033 12.998 10.132-20.393 11.362 33.491 9.731-35.13 28.1 53.665-18.852-13.247 12.239-22.207 17.703 30.483-7.646 6.018 7.989-35.063 20.219 35.31-13.225.132 3.635c-2.527.81-4.78 2.495-6.214 4.971-3.064 5.303-1.247 12.087 4.06 15.149.93.537 1.912.874 2.903 1.115l.242 6.826a5.25 5.25 0 0 0-2.178 2.053 5.26 5.26 0 0 0 1.924 7.178c.193.11.395.181.593.264l.229 6.406a4.06 4.06 0 0 0-2.383 1.865 4.09 4.09 0 0 0 1.496 5.581c.371.215.767.344 1.165.43l.434 12.239.647-12.129c1.343-.073 2.62-.788 3.335-2.034a4.08 4.08 0 0 0-1.496-5.581 4 4 0 0 0-1.402-.488l.318-5.864a5.251 5.251 0 0 0 2.316-9.788 5.2 5.2 0 0 0-1.763-.615l.33-6.064c3.401-.364 6.594-2.261 8.438-5.454 3.064-5.303 1.245-12.082-4.06-15.149-1.023-.591-2.112-.947-3.21-1.184l.181-3.335 30.024 14.175-29.656-21.165 6.548-4.709 13.149-3.987-9.487-13.425 9.463-4.604 6.701 9.631 9.688-5.401 9.48 7.415 10.566-2.754 19.9 10.474c-.903 3.692.635 7.666 4.089 9.658 3.657 2.112 8.213 1.282 10.916-1.755l20.42 10.75-19.336-12.285c2.348-4.181.915-9.474-3.246-11.879M348.537 205.085l36.365 4.614 6.572-3.789-27.603-19.785 31.389 13.293-4.854-37.38 13.198 36.863 9.6-5.54 7.971-15.388.12 10.718 2.019-1.167 10.62-6.128c4.243-.815 8.474-1.67 12.949-2.087-2.603 3.664-5.454 6.902-8.284 10.173l-10.613 6.128-1.519.876 8.345 3.943-16.433.725-9.097 5.254 24.236 29.138-28.95-22.183-4.878 33.628-2.539-33.579-7.583 4.378-13.33 30.61 5.305-25.977c-2.212 1.272-4.426 2.544-6.611 3.87-4.231.84-8.462 1.687-12.971 2.044 2.563-3.731 5.413-6.965 8.257-10.21 2.241-1.228 4.451-2.51 6.655-3.789zm-217.92 21.208c-2.181-1.326-4.396-2.598-6.609-3.87l6.157 29.165-14.183-33.799-6.571-3.794-3.336 33.794-4.178-33.828-29.944 22.888 25.329-29.858-9.606-5.545-17.307.791 9.22-5.461-2.023-1.167-10.615-6.128c-2.827-3.276-5.68-6.509-8.281-10.173 4.477.417 8.704 1.272 12.951 2.082l10.617 6.128 1.516.876-.757-9.197 8.844 13.867 9.099 5.252 13.117-35.559-4.739 36.167 31.565-12.59-27.811 18.987 7.581 4.377 33.175-3.76-25.149 8.394a294 294 0 0 0 6.655 3.794c2.843 3.247 5.693 6.482 8.258 10.21-4.513-.356-8.74-1.205-12.975-2.043m26.399 151.372-36.365-4.614-6.571 3.794 27.6 19.785-31.387-13.296 4.851 37.378-13.196-36.863-9.604 5.545-7.969 15.386-.12-10.718-2.021 1.169-10.617 6.128c-4.247.81-8.474 1.665-12.951 2.082 2.602-3.665 5.454-6.9 8.281-10.173l10.614-6.128 1.518-.876-8.345-3.943 16.433-.725 9.097-5.254-24.237-29.138 28.953 22.185 4.879-33.63 2.538 33.579 7.583-4.378 13.329-30.606-5.305 25.972c2.216-1.267 4.43-2.539 6.611-3.865 4.235-.84 8.462-1.687 12.974-2.048-2.565 3.73-5.415 6.968-8.258 10.215-2.239 1.226-4.448 2.507-6.655 3.789zm97.71-82.897-3.911-.01-1.951-3.389 1.963-3.381 3.914.007 1.948 3.389zm20.813-43.551-4.719 17.749-6.675 3.486-.308-7.981zM224.048 165.3l20.302-29.185v-7.585l-29.057 14.006 28.146-20.535-36.203-14.487 37.114 7.007v-11.094l-9.34-14.59 9.34 5.252V79.497c2.5-4.085 3.125-8.172 5-12.256 1.875 4.085 5 8.172 5 12.256v14.008l7.588-5.254-7.588 14.592v10.508l38.906-6.421-32.917 13.982 25.525 21.04-31.514-14.592v8.755l21.391 26.848-19.07-17.583c-.007 2.554.373 5.108.432 7.661-1.392 4.087-2.573 8.172-4.522 12.258-1.948-4.087-3.227-8.172-4.619-12.258.059-2.554-.837-5.107-.845-7.661zm18.344 99.243-.318 7.527-7.066-3.723-5.629-16.763zm-18.443 30.706-17.331-3.504 17.729-4.792 6.359 4.041zm6.066 36.286 4.716-17.751 6.677-3.484.308 7.981zm48.065 85.916-23.73 29.184v7.588l32.485-14.009-26.438 20.534 33.635 14.487-39.682-7.004v11.091l9.341 14.592-9.341-5.254v14.592c0 4.084-3.125 8.172-5 12.256-1.872-4.084-2.5-8.171-5-12.256v-14.008l-7.59 5.254 7.59-14.592v-10.508l-35.476 6.421 34.627-13.979-28.093-21.04 28.943 14.59v-8.755l-17.966-26.848 20.781 17.583c.01-2.554.483-5.107.427-7.661 1.387-4.087 3.003-8.171 4.949-12.258 1.946 4.087 3.442 8.172 4.834 12.258-.059 2.554-.767 5.107-.762 7.661zm-14.922-99.244.322-7.524 7.065 3.721 5.628 16.763zm11.69-26.45 6.755-4.253 17.329 3.504-17.729 4.79zm159.087 109.602-10.618-6.128-1.516-.876.754 9.197-8.84-13.867-9.102-5.252-13.115 35.559 4.736-36.167-31.563 12.59 27.81-18.987-7.581-4.378-33.176 3.762 25.151-8.396c-2.207-1.282-4.417-2.563-6.658-3.789-2.844-3.247-5.691-6.484-8.257-10.215 4.512.356 8.74 1.208 12.971 2.048 2.185 1.326 4.4 2.598 6.609 3.865l-6.155-29.165 14.185 33.799 6.567 3.799 3.338-33.799 4.18 33.831 29.944-22.891-25.327 29.858 9.602 5.544 17.309-.788-9.219 5.459 2.019 1.167 10.615 6.133c2.829 3.269 5.681 6.504 8.284 10.169-4.473-.417-8.704-1.271-12.947-2.082" fill="currentColor"/>
</svg>
`,`<svg viewBox="0 0 249 284" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M124.652 109.79h-.023a4.34 4.34 0 0 1-4.317-4.364l.397-72.545c.013-2.397 2.068-4.316 4.364-4.317a4.34 4.34 0 0 1 4.317 4.364l-.397 72.545a4.34 4.34 0 0 1-4.341 4.317m-.27 52.7c-11.503 0-20.86-9.358-20.86-20.86s9.358-20.86 20.86-20.86 20.859 9.358 20.859 20.86c0 11.503-9.357 20.86-20.859 20.86m0-33.038c-6.716 0-12.179 5.463-12.179 12.179s5.463 12.179 12.179 12.179c6.714 0 12.177-5.463 12.177-12.179.001-6.716-5.462-12.179-12.177-12.179" fill="currentColor"/>
  <path d="M88.206 210.075a4.344 4.344 0 0 1-4.31-4.838l4.947-42.921-39.681-15.935a4.342 4.342 0 0 1-.109-8.011l39.644-17.175-6.041-42.333a4.34 4.34 0 0 1 6.884-4.1l34.696 25.746 33.64-26.397a4.343 4.343 0 0 1 6.993 3.912l-4.948 42.921 39.681 15.934a4.34 4.34 0 0 1 .108 8.011l-39.644 17.175 6.041 42.333a4.34 4.34 0 0 1-6.884 4.099l-34.696-25.745-33.64 26.398a4.34 4.34 0 0 1-2.681.926m-26.158-67.874 33.103 13.293a4.34 4.34 0 0 1 2.695 4.525l-4.136 35.878 28.063-22.021a4.336 4.336 0 0 1 5.267-.071l29.003 21.521-5.039-35.315a4.34 4.34 0 0 1 2.572-4.596l33.138-14.357-33.102-13.292a4.34 4.34 0 0 1-2.695-4.525l4.136-35.878-28.063 22.02a4.34 4.34 0 0 1-5.267.071L92.72 87.933l5.039 35.315a4.34 4.34 0 0 1-2.572 4.596zm62.479-73.503a4.33 4.33 0 0 1-2.543-.823l-19.979-14.451a4.341 4.341 0 0 1 5.087-7.035l17.422 12.602 17.999-13.155a4.34 4.34 0 1 1 5.123 7.009L127.09 67.862a4.34 4.34 0 0 1-2.563.836" fill="currentColor"/>
  <path d="M93.179 127.648a4.3 4.3 0 0 1-2.186-.595L28.366 90.437a4.34 4.34 0 1 1 4.38-7.495l62.628 36.616a4.34 4.34 0 0 1-2.195 8.09" fill="currentColor"/>
  <path d="M35.032 117.288a4.34 4.34 0 0 1-3.963-2.568 4.34 4.34 0 0 1 2.187-5.735l19.624-8.787-2.393-22.165a4.341 4.341 0 0 1 8.63-.933l2.733 25.303a4.34 4.34 0 0 1-2.541 4.428l-22.505 10.077a4.3 4.3 0 0 1-1.772.38m-5.139 82.468a4.34 4.34 0 0 1-2.155-8.112l63.024-35.928a4.341 4.341 0 0 1 4.3 7.541L32.04 199.184a4.3 4.3 0 0 1-2.146.572" fill="currentColor"/>
  <path d="M54.87 209.01q-.222 0-.448-.023a4.34 4.34 0 0 1-3.873-4.761l2.2-21.389-20.391-9.01a4.343 4.343 0 0 1-2.216-5.726 4.35 4.35 0 0 1 5.726-2.216l23.277 10.286a4.34 4.34 0 0 1 2.563 4.415l-2.524 24.528a4.34 4.34 0 0 1-4.313 3.896m68.844 45.686h-.023a4.34 4.34 0 0 1-4.317-4.364l.397-72.544a4.34 4.34 0 0 1 4.341-4.317h.023a4.34 4.34 0 0 1 4.317 4.364l-.397 72.544a4.34 4.34 0 0 1-4.341 4.317" fill="currentColor"/>
  <path d="M103.694 238.26a4.34 4.34 0 0 1-2.565-7.845l20.546-15.017a4.34 4.34 0 0 1 5.105-.013l19.98 14.45a4.34 4.34 0 0 1 .974 6.061 4.336 4.336 0 0 1-6.061.974l-17.423-12.6-17.999 13.155a4.3 4.3 0 0 1-2.557.835m114.509-37.348a4.3 4.3 0 0 1-2.186-.595l-62.627-36.616a4.34 4.34 0 1 1 4.381-7.495l62.627 36.616a4.34 4.34 0 0 1-2.195 8.09" fill="currentColor"/>
  <path d="M193.956 210.034a4.34 4.34 0 0 1-4.31-3.874l-2.732-25.301a4.34 4.34 0 0 1 2.541-4.428l22.505-10.078a4.34 4.34 0 0 1 5.735 2.187 4.34 4.34 0 0 1-2.187 5.735l-19.624 8.789 2.393 22.164a4.34 4.34 0 0 1-4.321 4.806m-38.101-81.919a4.34 4.34 0 0 1-2.155-8.113l63.024-35.929a4.342 4.342 0 0 1 4.301 7.541l-63.024 35.929a4.3 4.3 0 0 1-2.146.572M125.049 0c-5.736 0-10.404 4.667-10.404 10.404s4.667 10.405 10.404 10.405 10.405-4.667 10.405-10.405S130.786 0 125.049 0M16.273 66.429c-4.965-2.87-11.342-1.16-14.212 3.808a10.34 10.34 0 0 0-1.04 7.895 10.33 10.33 0 0 0 4.847 6.317 10.34 10.34 0 0 0 7.895 1.04 10.34 10.34 0 0 0 6.317-4.847c2.869-4.97 1.16-11.345-3.807-14.213m-3.178 130.186a10.36 10.36 0 0 0-7.895 1.04c-4.968 2.869-6.676 9.245-3.808 14.212a10.33 10.33 0 0 0 6.317 4.848 10.34 10.34 0 0 0 7.895-1.04 10.33 10.33 0 0 0 4.847-6.318c.72-2.684.35-5.488-1.04-7.894a10.33 10.33 0 0 0-6.316-4.848m110.62 65.837c-5.737 0-10.405 4.667-10.405 10.405s4.667 10.405 10.405 10.405c5.736 0 10.403-4.667 10.403-10.405s-4.667-10.405-10.403-10.405m119.181-63.641a10.36 10.36 0 0 0-7.895-1.04 10.34 10.34 0 0 0-6.317 4.848c-2.869 4.967-1.16 11.343 3.808 14.212a10.34 10.34 0 0 0 7.895 1.04 10.34 10.34 0 0 0 6.317-4.848 10.34 10.34 0 0 0 1.04-7.894 10.33 10.33 0 0 0-4.848-6.318m-7.227-112.167a10.34 10.34 0 0 0 7.895-1.04c4.968-2.869 6.676-9.244 3.808-14.212-2.871-4.969-9.243-6.676-14.212-3.808s-6.676 9.244-3.808 14.212a10.32 10.32 0 0 0 6.317 4.848" fill="currentColor"/>
  <path d="M214.65 117.746c-.586 0-1.182-.12-1.752-.371l-23.277-10.285a4.34 4.34 0 0 1-2.564-4.415l2.524-24.528c.245-2.385 2.378-4.135 4.761-3.873a4.34 4.34 0 0 1 3.873 4.761l-2.201 21.389 20.391 9.009a4.34 4.34 0 0 1-1.755 8.313" fill="currentColor"/>
</svg>
`
    ];

    // Hàm giả ngẫu nhiên có seed, để mỗi lần tải trang bố cục tuyết ổn định giống nhau
    function seededRandom(seed) {
        const value = Math.sin(seed + 1) * 43758.5453123;
        return value - Math.floor(value);
    }

    function buildFlakeData(count) {
        const flakes = [];
        for (let i = 0; i < count; i++) {
            const rand = (offset) => seededRandom(i * 17 + offset);
            flakes.push({
                id: i,
                left: rand(0) * 98 + 1,
                size: Math.round(rand(1) * 38 + 16),
                dur: rand(2) * 12 + 10,
                delay: -(rand(3) * 22),
                // TỰ ĐỘNG LẤY TỔNG SỐ LƯỢNG SVG ĐỂ RANDOM (Không còn bị cứng con số 6)
                crystalIdx: Math.floor(rand(4) * SVG_FLAKES.length),
                colorIdx: Math.floor(rand(5) * COLORS.length),
                variant: VARIANTS[Math.floor(rand(6) * VARIANTS.length)],
            });
        }
        return flakes;
    }

    function renderFlake(data) {
        const color = COLORS[data.colorIdx];
        const svgString = SVG_FLAKES[data.crystalIdx];

        const wrapper = document.createElement("div");
        wrapper.className = `flake ${data.variant}`;
        wrapper.style.left = `${data.left}%`;
        wrapper.style.setProperty("--dur", `${data.dur}s`);
        wrapper.style.setProperty("--delay", `${data.delay}s`);
        wrapper.style.width = `${data.size}px`;
        wrapper.style.height = `${data.size}px`;

        // Gán biến color của CSS để thẻ SVG bên trong "hút" màu thông qua currentColor
        wrapper.style.color = color;

        // Chèn mã SVG dạng text thẳng vào DOM (Rất nhanh và gọn)
        wrapper.innerHTML = svgString;

        // Đảm bảo SVG scale tràn ra khớp với size của wrapper
        const svgEl = wrapper.querySelector('svg');
        if (svgEl) {
            svgEl.style.width = "100%";
            svgEl.style.height = "100%";
            svgEl.style.display = "block";
        }

        return wrapper;
    }

    function init() {
        const scene = document.getElementById("snowScene");
        if (!scene) return;
        const fragment = document.createDocumentFragment();
        buildFlakeData(FLAKE_COUNT).forEach((data) => {
            fragment.appendChild(renderFlake(data));
        });
        scene.appendChild(fragment);
    }

    // Đợi chat tải + cuộn xong rồi mới build tuyết, tránh giành CPU với lúc fetch tin nhắn
    document.addEventListener("chat:ready", init, { once: true });
})();

function hideSnowNow() {
    const snow = document.getElementById('snowScene');
    if (snow) snow.style.display = 'none';
}

// Đường chính: user bấm vào 1 trong 3 tab
document.querySelectorAll('.tab-item').forEach(link => {
    link.addEventListener('click', hideSnowNow);
});

window.addEventListener('load', () => {
    const snow = document.getElementById('snowScene');
    // Nếu vì lý do gì đó (miss event, browser không hỗ trợ...) mà vẫn đang ẩn
    // thì sau khi trang load xong hoàn toàn, cứ hiện lại, không để mất vĩnh viễn
    if (snow && snow.style.display === 'none') {
        snow.style.display = '';
    }
});