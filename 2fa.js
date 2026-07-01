const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --- STATE ---
let myPassword = localStorage.getItem('auth_pass') || '';
let secretsData = [];
let isEditMode = false;
let videoStream = null;
let toastTimeout;

// --- DOM ELEMENTS ---
const widget = document.getElementById('two-fa'); // Vẫn giữ element này phòng khi CSS của bạn cần
const loginView = document.getElementById('login-view');
const otpListView = document.getElementById('otp-list');
const toolbar = document.getElementById('toolbar');
const loading = document.getElementById('loading');
const scanMenu = document.getElementById('scan-menu');
const toast = document.getElementById('toast');

// --- PAGE LIFECYCLE LOGIC (THAY THẾ TOGGLE LOGIC) ---

// 1. Khi người dùng truy cập trang (Tải xong HTML)
window.addEventListener('DOMContentLoaded', () => {
    // Nếu CSS cũ của bạn dùng class 'expand' để hiện UI, hãy add nó ngay từ đầu
    if (widget) {
        widget.classList.add('expand');
    }

    // Xóa sạch thông báo lỗi cũ (nếu có)
    const errEl = document.getElementById('login-error');
    if (errEl) {
        errEl.style.display = 'none';
        errEl.innerText = '';
    }

    scanMenu.style.display = 'none';

    // Tự động chạy luồng đăng nhập
    checkAutoLogin();
});

// 2. Khi người dùng thoát trang (Đóng tab, F5, v.v.)
window.addEventListener('beforeunload', () => {
    // Dọn dẹp interval đếm ngược OTP
    if (window.otpInterval) {
        clearInterval(window.otpInterval);
    }
    // Đảm bảo luồng video camera bị tắt để không treo tài nguyên
    stopCamera();
});

// --- LOGIC AUTH ---

async function checkAutoLogin() {
    myPassword = localStorage.getItem('auth_pass') || '';
    if (myPassword) {
        // Truyền true: Đây là Auto Login
        await fetchSecrets(true);
    } else {
        showLogin();
    }
}

function showLogin() {
    loginView.style.display = 'flex';
    otpListView.style.display = 'none';
    toolbar.style.display = 'none';
    document.getElementById('edit-btn').style.opacity = '0';
    document.getElementById('header').style.opacity = '0';
    document.getElementById('two-fa-icon').style.opacity = '0';

    // Xóa mật khẩu cũ trong input
    document.getElementById('password-input').value = '';

    // RESET DÒNG THÔNG BÁO LỖI
    const errEl = document.getElementById('login-error');
    if (errEl) {
        errEl.innerText = '';
        errEl.style.display = 'none';
    }
}

async function login() {
    const pass = document.getElementById('password-input').value;
    if (!pass) return alert("Chưa nhập mật khẩu!");

    myPassword = pass;
    // Lưu lại password để lần sau checkAutoLogin có thể dùng
    localStorage.setItem('auth_pass', pass);

    await fetchSecrets();
}

function logout() {
    // Xóa sạch để lần sau phải nhập lại
    localStorage.removeItem('auth_pass');
    myPassword = '';
    document.getElementById('password-input').value = '';
    secretsData = [];
    showLogin();
}

// Thêm tham số isAutoLogin (mặc định là false)
async function fetchSecrets(isAutoLogin = false) {
    loading.classList.add('active');

    const { data, error } = await supabaseClient.rpc('get_secrets_securely', { input_pass: myPassword });

    loading.classList.remove('active');

    if (error) {
        console.error(error);

        // --- LOGIC MỚI ---
        if (isAutoLogin) {
            // Nếu là Auto Login mà sai:
            // 1. Không hiện lỗi đỏ (để người dùng thấy form sạch)
            // 2. Xóa luôn password sai trong localStorage
            localStorage.removeItem('auth_pass');
            document.getElementById('password-input').value = '';

            // Đảm bảo ẩn lỗi và hiện form
            const errEl = document.getElementById('login-error');
            if (errEl) errEl.style.display = 'none';
            loginView.style.display = 'flex';

        } else {
            // Nếu là Tự bấm nút Login mà sai -> Hiện lỗi đỏ
            const errEl = document.getElementById('login-error');
            if (errEl) {
                errEl.innerText = "Mật khẩu sai hoặc Lỗi kết nối!";
                errEl.style.display = 'block';
            }
            loginView.style.display = 'flex';
        }

    } else {
        // Thành công
        const errEl = document.getElementById('login-error');
        if (errEl) errEl.style.display = 'none';

        secretsData = data;
        loginView.style.display = 'none';
        otpListView.style.display = 'block';
        toolbar.style.display = 'grid';
        renderOTP();
        if (window.otpInterval) clearInterval(window.otpInterval);
        window.otpInterval = setInterval(renderOTP, 1000);
    }
}

async function addSecretRPC(uri, name, account, secret) {
    const { error } = await supabaseClient.rpc('add_secret_securely', {
        input_pass: myPassword, s_name: name, acc_name: account, s_key: secret, uri: uri
    });
    return error;
}

async function deleteSecretRPC(id) {
    if (!confirm("Xóa mã này vĩnh viễn?")) return;

    loading.classList.add('active'); // Bật loading

    const { error } = await supabaseClient.rpc('delete_secret_securely', {
        input_pass: myPassword, secret_id: id
    });

    loading.classList.remove('active'); // Tắt loading

    if (!error) fetchSecrets();
}

async function moveItem(index, direction) {
    if (index + direction < 0 || index + direction >= secretsData.length) return;

    loading.classList.add('active'); // Bật loading

    const itemA = secretsData[index];
    const itemB = secretsData[index + direction];
    await supabaseClient.rpc('update_secret_order', { input_pass: myPassword, secret_id: itemA.id, new_order: itemB.sort_order });
    await supabaseClient.rpc('update_secret_order', { input_pass: myPassword, secret_id: itemB.id, new_order: itemA.sort_order });

    loading.classList.remove('active'); // Tắt loading

    fetchSecrets();
}

// --- UI RENDER ---
function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => {
        toast.innerText = `Copied`;
        toast.style.opacity = '1';
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.style.opacity = '0';
        }, 1000);
    });
}

function renderOTP() {
    if (loginView.style.display === 'flex') return;

    const epoch = Math.round(new Date().getTime() / 1000.0);
    const countDown = 30 - (epoch % 30);
    const deg = (countDown / 30) * 360;

    const chevronUp = `<svg viewBox="0 0 448 512"><path d="M240.971 130.524l194.343 194.343c9.373 9.373 9.373 24.569 0 33.941l-22.667 22.667c-9.357 9.357-24.522 9.375-33.901.04L224 227.495 69.255 381.516c-9.379 9.335-24.544 9.317-33.901-.04l-22.667-22.667c-9.373-9.373-9.373-24.569 0-33.941L207.03 130.525c9.372-9.372 24.568-9.372 33.941-.001z"/></svg>`;
    const chevronDown = `<svg viewBox="0 0 448 512"><path d="M207.029 381.476L12.686 187.132c-9.373-9.373-9.373-24.569 0-33.941l22.667-22.667c9.357-9.357 24.522-9.375 33.901-.04L224 284.505l154.745-154.021c9.379-9.335 24.544-9.317 33.901.04l22.667 22.667c9.373 9.373 9.373 24.569 0 33.941L240.971 381.476c-9.373 9.372-24.569 9.372-33.942 0z"/></svg>`;
    const trashIcon = `<svg viewBox="0 0 24 24" fill="red"><path d="M10.111 2c-.736 0-1.333.597-1.333 1.333A.667.667 0 0 1 8.11 4H5a1 1 0 0 0 0 2h14a1 1 0 1 0 0-2h-3.112a.667.667 0 0 1-.666-.667c0-.736-.597-1.333-1.333-1.333zM6 8a1 1 0 0 0-.997 1.083l.771 9.25A4 4 0 0 0 9.76 22h4.48a4 4 0 0 0 3.986-3.668l.77-9.249A1 1 0 0 0 18 8z"/></svg>`;
    const ghostIcon = `<svg viewBox="0 0 384 512" style="font-size:40px; margin-bottom:10px; opacity:0.3; width:40px; height:40px;"><path d="M192 0C86 0 0 86 0 192v277.5c0 14.8 16.9 23.5 29 14.9l43-30.5 43 30.5c11.9 8.5 28.1 8.5 40 0l43-30.5 43 30.5c11.9 8.5 28.1 8.5 40 0l43-30.5 43 30.5c12.1 8.6 29-1.3 29-14.9V192C384 86 298 0 192 0zm-80 176c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32zm160 0c-17.7 0-32-14.3-32-32s14.3-32 32-32 32 14.3 32 32-14.3 32-32 32z"/></svg>`;

    let html = '';
    if (secretsData && secretsData.length > 0) {
        secretsData.forEach((item, index) => {
            let otpCode = "ERROR";
            try {
                const totp = new OTPAuth.TOTP({
                    algorithm: 'SHA1', digits: 6, period: 30,
                    secret: OTPAuth.Secret.fromBase32(item.secret_key)
                });
                otpCode = totp.generate();
            } catch (e) { otpCode = "INVALID"; }

            // --- XỬ LÝ ICON (SVG hoặc ẢNH) ---
            let iconHtml = '';
            const iconSource = item.icon_svg ? item.icon_svg.trim() : '';
            const firstLetter = (item.service_name || '?').charAt(0).toUpperCase();

            if (iconSource) {
                // Kiểm tra xem là mã SVG hay Link ảnh
                if (iconSource.startsWith('<')) {
                    // Là mã SVG
                    iconHtml = `<div class="icon-container custom-svg">${iconSource}</div>`;
                } else {
                    // Là đường dẫn ảnh
                    iconHtml = `
                        <div class="icon-container custom-img">
                            <img src="${iconSource}" alt="${item.service_name}" 
                                 onerror="this.parentElement.innerHTML='${firstLetter}'; this.parentElement.classList.remove('custom-img');">
                        </div>`;
                }
            } else {
                // Không có icon -> dùng chữ cái đầu
                iconHtml = `<div class="icon-container">${firstLetter}</div>`;
            }
            // ----------------------------------

            html += `
                <div class="otp-item ${isEditMode ? 'show-edit' : ''}" onclick="copyCode('${otpCode}')">
                    ${iconHtml}
                    <div class="otp-info">
                        <span class="service-name">${item.service_name || 'Unknown'}</span>
                        <span class="otp-code">${otpCode}</span>
                        <span class="account-name">${item.account_name || ''}</span>
                    </div>
                    <div class="pie-timer" style="--deg: ${deg}deg"></div>
                    <div class="edit-controls">
                        <div class="move-btn" onclick="moveItem(${index}, -1)">${chevronUp}</div>
                        <div id="delete-otp-btn" onclick="deleteSecretRPC(${item.id})">${trashIcon}</div>
                        <div class="move-btn" onclick="moveItem(${index}, 1)">${chevronDown}</div>
                    </div>
                </div>`;
        });
    } else {
        html = `
            <div style="padding:40px 20px; text-align:center; color:#999; display:flex; flex-direction:column; align-items:center;">
                ${ghostIcon}
                <div>Chưa có mã nào.<br>Hãy Import hoặc Scan để bắt đầu.</div>
            </div>`;
    }
    
    otpListView.innerHTML = html;
    document.getElementById('header').style.opacity = '1';
    document.getElementById('two-fa-icon').style.opacity = '1';
    document.getElementById('edit-btn').style.opacity = '1';
}

// --- MENU TOGGLES ---
function toggleEditMode(e) {
    e.stopPropagation();
    isEditMode = !isEditMode;
    renderOTP();
}

function toggleScanMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('scan-menu');
    menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
}

// --- IMPORT / EXPORT ---
function triggerImport() { document.getElementById('file-input').click(); }

function handleFileImport(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        const content = e.target.result;
        const lines = content.split('\n');

        loading.classList.add('active'); // Bật loading

        let count = 0;
        for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('otpauth://')) continue;
            try {
                // Xử lý import
                const url = new URL(line);
                const secret = url.searchParams.get('secret');
                const issuer = url.searchParams.get('issuer') || '';
                const account = decodeURIComponent(url.pathname.replace(/^\/totp\//, ''));
                if (secret) { await addSecretRPC(line, issuer, account, secret); count++; }
            } catch (err) { console.error("Parse error", err); }
        }

        loading.classList.remove('active'); // Tắt loading

        alert(`Đã import ${count} mã thành công!`);
        fetchSecrets();
    };
    reader.readAsText(file);
}

function exportData() {
    let txt = '';
    secretsData.forEach(s => {
        txt += (s.original_uri || `otpauth://totp/${s.service_name}:${s.account_name}?secret=${s.secret_key}&issuer=${s.service_name}`) + '\n';
    });
    const blob = new Blob([txt], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'authenticator_backup.txt';
    a.click();
}

// --- CAMERA FUNCTIONS ---
function startCamera() {
    document.getElementById('scan-menu').style.display = 'none';
    document.getElementById('camera-modal').style.display = 'flex';
    const video = document.getElementById('qr-video');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(stream => {
        videoStream = stream;
        video.srcObject = stream;
        video.setAttribute("playsinline", true);
        video.play();
        requestAnimationFrame(tickCamera);
    }).catch(err => alert("Không thể mở camera: " + err));
}

function tickCamera() {
    const video = document.getElementById('qr-video');
    if (video.readyState === video.HAVE_ENOUGH_DATA && document.getElementById('camera-modal').style.display === 'flex') {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
        if (code) { stopCamera(); handleScanResult(code.data); }
        else requestAnimationFrame(tickCamera);
    } else requestAnimationFrame(tickCamera);
}

function stopCamera() {
    document.getElementById('camera-modal').style.display = 'none';
    if (videoStream) { videoStream.getTracks().forEach(track => track.stop()); videoStream = null; }
}

async function scanScreen(e) {
    document.getElementById('scan-menu').style.display = 'none';
    e.stopPropagation();
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "never" } });
        const track = stream.getVideoTracks()[0];
        if (!window.ImageCapture) { alert("Trình duyệt này chưa hỗ trợ chụp màn hình."); track.stop(); return; }
        const imageCapture = new ImageCapture(track);
        await new Promise(r => setTimeout(r, 500));
        try {
            const bitmap = await imageCapture.grabFrame();
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            track.stop();
            if (code) handleScanResult(code.data);
            else alert("Không thấy mã QR nào.");
        } catch (err) { track.stop(); }
    } catch (err) { console.error(err); }
}

async function handleScanResult(data) {
    if (data.startsWith('otpauth://')) {
        if (confirm(`Tìm thấy mã 2FA!\nThêm vào danh sách ngay?`)) {
            const url = new URL(data);
            const secret = url.searchParams.get('secret');
            const issuer = url.searchParams.get('issuer') || '';
            const path = decodeURIComponent(url.pathname.replace(/^\/totp\//, ''));

            loading.classList.add('active'); // Bật loading

            await addSecretRPC(data, issuer, path, secret);

            loading.classList.remove('active'); // Tắt loading

            fetchSecrets();
        }
    } else alert("Mã QR này không hợp lệ.");
}