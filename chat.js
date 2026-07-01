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

    renderInitialList(items);
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
function renderInitialList(items) {
    const listDiv = document.getElementById('messageList');
    if (!listDiv) return;

    listDiv.innerHTML = "";
    renderedMessageIds.clear();

    items.forEach(item => {
        const node = buildMessageNode(item);
        listDiv.appendChild(node);
        renderedMessageIds.add(item.id);
    });

    waitForMediaReady(listDiv, 6000).then(() => {
        listDiv.scrollTop = listDiv.scrollHeight;
    });
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
  const SVG_NS = "http://www.w3.org/2000/svg";
  const COLORS = ["#a8d8f0", "#c3e8ff", "#b0deff", "#d6f0ff", "#7ec8e3", "#e0f4ff", "#90cce8", "#bce8fa"];
  const VARIANTS = ["v-a", "v-b", "v-c", "v-d"];
  const FLAKE_COUNT = 80;

  // Tạo phần tử SVG/HTML từ khai báo dạng object đơn giản
  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    children.forEach((child) => node.appendChild(child));
    return node;
  }

  function makeSvg(children, size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("fill", "none");
    children.forEach((child) => svg.appendChild(child));
    return svg;
  }

  // 6 kiểu hoa tuyết (crystal) khác nhau, mô phỏng lại thiết kế gốc
  const CRYSTAL_BUILDERS = [
    // 0: cơ bản, 6 nhánh đơn giản
    (color, size) => {
      const children = [];
      [0, 60, 120, 180, 240, 300].forEach((deg) => {
        const g = el("g", { transform: `rotate(${deg} 50 50)` }, [
          el("line", { x1: 50, y1: 50, x2: 50, y2: 8, stroke: color, "stroke-width": 3.5, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 26, x2: 38, y2: 18, stroke: color, "stroke-width": 2.2, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 26, x2: 62, y2: 18, stroke: color, "stroke-width": 2.2, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 18, x2: 41, y2: 12, stroke: color, "stroke-width": 1.6, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 18, x2: 59, y2: 12, stroke: color, "stroke-width": 1.6, "stroke-linecap": "round" }),
        ]);
        children.push(g);
      });
      children.push(el("circle", { cx: 50, cy: 50, r: 4.5, fill: color }));
      return makeSvg(children, size);
    },
    // 1: có đỉnh kim cương nhỏ
    (color, size) => {
      const children = [];
      [0, 60, 120, 180, 240, 300].forEach((deg) => {
        const g = el("g", { transform: `rotate(${deg} 50 50)` }, [
          el("line", { x1: 50, y1: 50, x2: 50, y2: 7, stroke: color, "stroke-width": 3, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 22, x2: 40, y2: 15, stroke: color, "stroke-width": 2, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 22, x2: 60, y2: 15, stroke: color, "stroke-width": 2, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 34, x2: 42, y2: 28, stroke: color, "stroke-width": 1.8, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 34, x2: 58, y2: 28, stroke: color, "stroke-width": 1.8, "stroke-linecap": "round" }),
          el("polygon", { points: "50,7 46,12 50,17 54,12", fill: color, opacity: 0.8 }),
        ]);
        children.push(g);
      });
      children.push(el("circle", { cx: 50, cy: 50, r: 5, fill: color }));
      children.push(el("circle", { cx: 50, cy: 50, r: 3, fill: "white", opacity: 0.6 }));
      return makeSvg(children, size);
    },
    // 2: có lục giác nền mờ
    (color, size) => {
      const children = [
        el("polygon", {
          points: "50,12 71,24.5 71,49.5 50,62 29,49.5 29,24.5",
          stroke: color, "stroke-width": 2.5, fill: color, "fill-opacity": 0.12,
        }),
      ];
      [0, 60, 120, 180, 240, 300].forEach((deg) => {
        const g = el("g", { transform: `rotate(${deg} 50 50)` }, [
          el("line", { x1: 50, y1: 50, x2: 50, y2: 6, stroke: color, "stroke-width": 2.8, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 16, x2: 42, y2: 10, stroke: color, "stroke-width": 1.8, "stroke-linecap": "round" }),
          el("line", { x1: 50, y1: 16, x2: 58, y2: 10, stroke: color, "stroke-width": 1.8, "stroke-linecap": "round" }),
        ]);
        children.push(g);
      });
      children.push(el("circle", { cx: 50, cy: 50, r: 6, fill: color, opacity: 0.9 }));
      return makeSvg(children, size);
    },
    // 3: nhánh phân tầng nhiều lông tơ
    (color, size) => {
      const children = [];
      [0, 60, 120, 180, 240, 300].forEach((deg) => {
        const parts = [
          el("line", { x1: 50, y1: 50, x2: 50, y2: 6, stroke: color, "stroke-width": 3, "stroke-linecap": "round" }),
        ];
        [14, 22, 30, 38].forEach((y, i) => {
          parts.push(
            el("g", {}, [
              el("line", { x1: 50, y1: y, x2: 50 - (10 - i * 1.5), y2: y - 7 + i, stroke: color, "stroke-width": 2 - i * 0.3, "stroke-linecap": "round" }),
              el("line", { x1: 50, y1: y, x2: 50 + (10 - i * 1.5), y2: y - 7 + i, stroke: color, "stroke-width": 2 - i * 0.3, "stroke-linecap": "round" }),
            ])
          );
        });
        children.push(el("g", { transform: `rotate(${deg} 50 50)` }, parts));
      });
      children.push(el("circle", { cx: 50, cy: 50, r: 5, fill: color }));
      return makeSvg(children, size);
    },
    // 4: 8 cánh dạng thanh
    (color, size) => {
      const children = [];
      [0, 45, 90, 135, 180, 225, 270, 315].forEach((deg) => {
        children.push(
          el("g", { transform: `rotate(${deg} 50 50)` }, [
            el("rect", { x: 47.5, y: 16, width: 5, height: 24, rx: 2.5, fill: color, opacity: 0.85 }),
            el("line", { x1: 50, y1: 50, x2: 50, y2: 16, stroke: color, "stroke-width": 1.5, opacity: 0.5 }),
          ])
        );
      });
      children.push(el("circle", { cx: 50, cy: 50, r: 8, fill: color, opacity: 0.3 }));
      children.push(el("circle", { cx: 50, cy: 50, r: 5, fill: color }));
      return makeSvg(children, size);
    },
    // 5: nhiều tia nhỏ + tia lớn xen kẽ
    (color, size) => {
      const children = [];
      [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].forEach((deg, i) => {
        children.push(
          el("g", { transform: `rotate(${deg} 50 50)` }, [
            el("line", {
              x1: 50, y1: 50, x2: 50, y2: i % 2 === 0 ? 8 : 16,
              stroke: color, "stroke-width": i % 2 === 0 ? 2.5 : 1.8, "stroke-linecap": "round",
            }),
          ])
        );
      });
      [0, 60, 120, 180, 240, 300].forEach((deg) => {
        children.push(
          el("g", { transform: `rotate(${deg} 50 50)` }, [
            el("line", { x1: 50, y1: 20, x2: 43, y2: 14, stroke: color, "stroke-width": 1.5, "stroke-linecap": "round" }),
            el("line", { x1: 50, y1: 20, x2: 57, y2: 14, stroke: color, "stroke-width": 1.5, "stroke-linecap": "round" }),
          ])
        );
      });
      children.push(el("circle", { cx: 50, cy: 50, r: 5, fill: color }));
      children.push(el("circle", { cx: 50, cy: 50, r: 2.5, fill: "white", opacity: 0.7 }));
      return makeSvg(children, size);
    },
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
        crystalIdx: Math.floor(rand(4) * CRYSTAL_BUILDERS.length),
        colorIdx: Math.floor(rand(5) * COLORS.length),
        variant: VARIANTS[Math.floor(rand(6) * VARIANTS.length)],
      });
    }
    return flakes;
  }

  function renderFlake(data) {
    const color = COLORS[data.colorIdx];
    const buildCrystal = CRYSTAL_BUILDERS[data.crystalIdx];

    const wrapper = document.createElement("div");
    wrapper.className = `flake ${data.variant}`;
    wrapper.style.left = `${data.left}%`;
    wrapper.style.setProperty("--dur", `${data.dur}s`);
    wrapper.style.setProperty("--delay", `${data.delay}s`);
    wrapper.style.width = `${data.size}px`;
    wrapper.style.height = `${data.size}px`;

    wrapper.appendChild(buildCrystal(color, data.size));
    return wrapper;
  }

  function init() {
    const scene = document.getElementById("snowScene");
    const fragment = document.createDocumentFragment();
    buildFlakeData(FLAKE_COUNT).forEach((data) => {
      fragment.appendChild(renderFlake(data));
    });
    scene.appendChild(fragment);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
