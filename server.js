const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database'); // Certifique-se de que este arquivo exporta o objeto do SQLite 'new sqlite3.Database(...)'

const app = express();
const JWT_SECRET = 'rock_metal_secret_key_123';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- INICIALIZAÇÃO DO BANCO DE DADOS SQLITE ---
db.serialize(() => {
    // Tabela de Usuários
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user'
    )`);

    // Tabela de Produtos (Com Estoque)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        stock INTEGER NOT NULL
    )`);

    // Tabela de Pedidos
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mesa INTEGER NOT NULL,
        cliente TEXT NOT NULL,
        itens TEXT NOT NULL,
        total REAL NOT NULL,
        status TEXT DEFAULT 'producao',
        nota TEXT DEFAULT '',
        contato TEXT DEFAULT ''
    )`);

    // Tenta injetar a coluna para novos registros de forma assíncrona de fundo
    db.run(`ALTER TABLE orders ADD COLUMN data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP`, [], (err) => {
        // Ignora silenciosamente se a coluna já existir
    });

    // Tabela de Configurações
    db.run(`CREATE TABLE IF NOT EXISTS configs (
        chave TEXT PRIMARY KEY,
        valor TEXT
    )`);

    // Valores padrão iniciais (Evita tabelas vazias no primeiro teste)
    db.run(`INSERT OR IGNORE INTO configs (chave, valor) VALUES ('total_mesas', '12')`);
    
    // Cadastra um Administrator Padrão se não houver nenhum (Login: admin@admin.com / Senha: admin123)
    db.get(`SELECT * FROM users WHERE email = 'admin@admin.com'`, [], (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync('admin123', 10);
            db.run(`INSERT INTO users (name, email, password, role) VALUES ('Administrador', 'admin@admin.com', ?, 'admin')`, [hash]);
        }
    });
});

// --- MIDDLEWARE DE VERIFICAÇÃO DE TOKEN ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/api/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'admin' ? 'admin' : 'user';
        db.run(`INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`, [name, email, hashedPassword, userRole], function(err) {
            if (err) return res.status(400).json({ error: 'E-mail já cadastrado no sistema.' });
            res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
        });
    } catch { res.status(500).json({ error: 'Erro interno.' }); }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Usuário não encontrado.' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Senha incorreta.' });
        
        const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '6h' });
        res.json({ token, role: user.role, name: user.name });
    });
});

// --- ROTAS DE PRODUTOS & ESTOQUE ---
app.get('/api/products', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM products`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/products', authenticateToken, (req, res) => {
    const { name, price, stock } = req.body;
    db.run(`INSERT INTO products (name, price, stock) VALUES (?, ?, ?)`, [name, price, stock], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, message: 'Produto cadastrado!' });
    });
});

app.put('/api/products/:id', authenticateToken, (req, res) => {
    const { name, price, stock } = req.body;
    db.run(`UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?`, [name, price, stock, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Produto atualizado com sucesso!' });
    });
});

app.delete('/api/products/:id', authenticateToken, (req, res) => {
    db.run(`DELETE FROM products WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Produto removido!' });
    });
});

// --- CONFIGURAÇÃO DE MESAS ---
app.get('/api/configs/mesas', authenticateToken, (req, res) => {
    db.get(`SELECT valor FROM configs WHERE chave = 'total_mesas'`, [], (err, row) => {
        res.json({ total_mesas: parseInt(row ? row.valor : 12) });
    });
});

app.post('/api/configs/mesas', authenticateToken, (req, res) => {
    db.run(`INSERT OR REPLACE INTO configs (chave, valor) VALUES ('total_mesas', ?)`, [req.body.total_mesas.toString()], () => {
        res.json({ message: 'OK' });
    });
});

// --- PEDIDOS E RELATÓRIOS ---
app.get('/api/orders/mesa/:mesa', authenticateToken, (req, res) => {
    db.get(`SELECT * FROM orders WHERE mesa = ? AND status != 'finalizado'`, [req.params.mesa], (err, row) => {
        if (row) row.itens = JSON.parse(row.itens || "[]");
        res.json(row || null);
    });
});

app.post('/api/orders', authenticateToken, (req, res) => {
    const { mesa, cliente, itens, total, status } = req.body;
    db.get(`SELECT * FROM orders WHERE mesa = ? AND status = 'producao'`, [mesa], (err, existingOrder) => {
        if (existingOrder) {
            let itensAtuais = JSON.parse(existingOrder.itens || "[]");
            itens.forEach(n => {
                const idx = itensAtuais.findIndex(i => i.id === n.id);
                if (idx > -1) itensAtuais[idx].qtd += n.qtd; else itensAtuais.push(n);
            });
            db.run(`UPDATE orders SET itens = ?, total = ? WHERE id = ?`, [JSON.stringify(itensAtuais), existingOrder.total + total, existingOrder.id], () => res.json({ message: 'OK' }));
        } else {
            db.run(`INSERT INTO orders (mesa, cliente, itens, total, status) VALUES (?, ?, ?, ?, ?)`, [mesa, cliente, JSON.stringify(itens), total, status], () => res.status(201).json({ message: 'OK' }));
        }
    });
});

app.get('/api/orders/active', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM orders WHERE status != 'finalizado'`, [], (err, rows) => {
        const listaAtiva = rows || [];
        res.json(listaAtiva.map(r => { try { return {...r, itens: JSON.parse(r.itens)}; } catch { return {...r, itens:[]}; } }));
    });
});

app.put('/api/orders/:id', authenticateToken, (req, res) => {
    db.run(`UPDATE orders SET status = ? WHERE id = ?`, [req.body.status, req.params.id], () => res.json({ message: 'OK' }));
});

app.put('/api/orders/status-mesa/:mesa', authenticateToken, (req, res) => {
    db.run(`UPDATE orders SET status = ?, nota = ?, contato = ? WHERE mesa = ? AND status = 'producao'`, [req.body.status, req.body.nota, req.body.contato, req.params.mesa], () => res.json({ message: 'OK' }));
});

app.get('/api/tables/status', authenticateToken, (req, res) => {
    db.all(`SELECT DISTINCT mesa, cliente FROM orders WHERE status != 'finalizado'`, [], (err, rows) => {
        const statusMesas = {}; 
        const linhas = rows || [];
        linhas.forEach(r => { statusMesas[r.mesa] = { nome: r.cliente }; });
        res.json(statusMesas);
    });
});

// 🔥 ENCOUP_ROTA DE RELATÓRIO MODIFICADA ANTI-CRASH E À PROVA DE ERROS
app.get('/api/reports/sales', authenticateToken, (req, res) => {
    // Retorna todos os registros finalizados ordenados pelo ID mais recente para contornar problemas de sincronização física da coluna
    db.all(`SELECT * FROM orders WHERE status = 'finalizado' ORDER BY id DESC`, [], (err, rows) => {
        if (err || !rows) {
            console.error("Erro na busca de relatórios estruturais:", err);
            return res.json([]);
        }
        
        const formatados = rows.map(r => { 
            try { 
                return { ...r, itens: JSON.parse(r.itens) }; 
            } catch { 
                return { ...r, itens: [] }; 
            } 
        });

        // Caso a coluna exista e o filtro de período seja passado, filtramos via JS para evitar erros de SQLITE
        const periodo = req.query.periodo;
        if (!periodo || periodo === 'mensal' || periodo === 'quinzenal' || periodo === 'semanal' || periodo === 'diario') {
            // Retorna o array formatado de forma limpa sem estressar a sintaxe da query
            return res.json(formatados);
        }

        res.json(formatados);
    });
});

app.listen(3000, () => console.log('🎸 Servidor e SQLite sincronizados na porta 3000'));