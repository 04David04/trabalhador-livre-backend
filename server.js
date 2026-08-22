

require('dotenv').config(); // Carrega as variáveis do .env
const bcrypt = require('bcrypt');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const app = express();

app.use(cors());
app.use(express.json());

// 1. Pega as variáveis de ambiente
const supabaseUrl = process.env.SUPABASE_URL;
// Usamos a SERVICE_ROLE_KEY para ignorar as restrições de RLS no servidor
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 2. Cria o cliente Supabase com a Chave de Administrador (Service Role)
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Configuração do Multer para receber ficheiros na memória
const upload = multer({ storage: multer.memoryStorage() });

// Rota de teste inicial
app.get('/', (req, res) => {
  res.send('O meu servidor está VIVO e configurado!');
});

// 2. ROTA REAL: Buscar a lista de profissionais da base de dados
app.get('/api/profissionais', async (req, res) => {
  try {
    // Consulta a tabela 'profissionais' do Supabase
    const { data, error } = await supabase
      .from('profissionais')
      .select('*');

    if (error) throw error;

    // Retorna os dados em formato JSON para o Front-end
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROTA 2: Cliente envia uma avaliação sobre um profissional
app.post('/api/avaliacoes', async (req, res) => {
  try {
    // 1. Extraímos os dados que o cliente envia no formulário
    const { profissional_id, cliente_nome, classificacao, pontos, comentario } = req.body;

    // 2. Inserimos a nova avaliação na tabela 'avaliacoes'
    const { data, error } = await supabase
      .from('avaliacoes')
      .insert([
        {
          profissional_id,
          cliente_nome: cliente_nome || 'Anónimo',
          classificacao,
          pontos,
          comentario,
          status: 'PENDENTE' // Todas as avaliações entram em moderação por padrão
        }
      ]);

    if (error) throw error;

    // 3. Resposta de sucesso enviada de volta ao cliente
    res.status(201).json({ message: 'Avaliação enviada com sucesso! Aguarda aprovação do Admin.' });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* =========================================================
   ROTAS DE ADMINISTRAÇÃO (MODERAÇÃO)
   ========================================================= */

// 1. Admin busca todas as avaliações (podes filtrar por status: ?status=PENDENTE)
app.get('/api/admin/avaliacoes', async (req, res) => {
  try {
    const { status } = req.query; // Pega o parâmetro da URL (ex: ?status=PENDENTE)

    let query = supabase.from('avaliacoes').select('*, profissionais(nome, profissao)');

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Admin APROVA a avaliação e SOMA os pontos ao profissional
app.patch('/api/admin/avaliacoes/:id/aprovar', async (req, res) => {
  try {
    const { id } = req.params; // ID da avaliação
    const { profissional_id, pontos } = req.body; // Dados vindos do Front-end

    // A. Mudar o status da avaliação para APROVADO
    const { error: errorAval } = await supabase
      .from('avaliacoes')
      .update({ status: 'APROVADO' })
      .eq('id', id);

    if (errorAval) throw errorAval;

    // B. Buscar os pontos atuais do profissional
    const { data: prof, error: errorProf } = await supabase
      .from('profissionais')
      .select('pontos_totais')
      .eq('id', profissional_id)
      .single();

    if (errorProf) throw errorProf;

    // C. Calcular a nova pontuação e atualizar o profissional
    const novaPontuacao = (prof.pontos_totais || 0) + Number(pontos);

    const { error: errorUpdate } = await supabase
      .from('profissionais')
      .update({ pontos_totais: novaPontuacao })
      .eq('id', profissional_id);

    if (errorUpdate) throw errorUpdate;

    res.json({ message: 'Avaliação aprovada e pontos do profissional atualizados!' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 3. Admin REJEITA a avaliação
app.patch('/api/admin/avaliacoes/:id/rejeitar', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('avaliacoes')
      .update({ status: 'REJEITADO' })
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Avaliação rejeitada.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ROTA: Cadastrar novo profissional com Foto Automática
app.post('/api/profissionais', upload.single('foto'), async (req, res) => {
  try {
    const { 
      nome, profissao,status, telefone, whatsapp, email, localizacao, trabalho, domicilio, senha
    } = req.body;

  
    let fotoUrl = null;

    // Se o utilizador enviou uma foto no formulário
    if (req.file) {
      const file = req.file;
      const fileName = `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`;

      // Upload para o Bucket 'profissionais' no Supabase Storage
      const { data: storageData, error: storageError } = await supabase.storage
        .from('profissionais')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });

      if (storageError) throw storageError;

      // Pega a URL pública da imagem
      const { data: publicUrlData } = supabase.storage
        .from('profissionais')
        .getPublicUrl(fileName);

      fotoUrl = publicUrlData.publicUrl;
    }


   const saltRounds = 10;
   const senhaHash = await bcrypt.hash(senha, saltRounds);

    // Inserir os dados no banco PostgreSQL / Supabase
    const { data, error } = await supabase
      .from('profissionais')
      .insert([
        {
          nome,
          profissao,
          status: status || 'Disponível',
          telefone,
          whatsapp,
          email,
          localizacao,
          trabalho,
          domicilio: domicilio || 'Sim',
          foto: fotoUrl, 
          verificado: false,
          visualizacoes: 0,
          trabalhos_realizados: 0,
          avaliacao: 0.0,
          senha: senhaHash, // Armazena a senha criptografada
        }
      ])
      .select();

    if (error) throw error;

    res.status(201).json({ message: 'Profissional cadastrado com sucesso!', data });

  } catch (error) {
    console.error('Erro no cadastro:', error);
    // 🔴 GARANTIR QUE RETORNA O ERRO EM JSON PARA O REACT:
    res.status(500).json({ error: error.message || 'Erro interno ao cadastrar profissional.' });
  }
});



// ROTA DE LOGIN (Aceita Contacto ou E-mail)
app.post('/api/login', async (req, res) => {
  try {
    const { login, senha } = req.body;

    // 1. Validação simples
    if (!login || !senha) {
      return res.status(400).json({ error: 'Por favor, preencha o contacto/e-mail e a senha.' });
    }

    const termo = login.trim();

    // 2. Busca no Supabase por telefone ou email, usando consultas separadas para evitar falhas na query OR
    const { data: profissionalPorTelefone, error: errorTelefone } = await supabase
      .from('profissionais')
      .select('*')
      .eq('telefone', termo)
      .maybeSingle();

    const { data: profissionalPorEmail, error: errorEmail } = await supabase
      .from('profissionais')
      .select('*')
      .eq('email', termo)
      .maybeSingle();

    const profissional = profissionalPorTelefone || profissionalPorEmail;

    if (errorTelefone || errorEmail || !profissional) {
      return res.status(404).json({ error: 'Nenhum profissional encontrado com este contacto ou e-mail.' });
    }

    // 3. Compara a senha digitada com o hash salvo no banco
    const senhaValida = await bcrypt.compare(senha, profissional.senha);

    if (!senhaValida) {
      return res.status(401).json({ error: 'Senha incorreta. Tente novamente.' });
    }

    // 4. Remove a senha do objeto antes de enviar ao Front-end por segurança
    delete profissional.senha;

    // 5. Retorna sucesso e os dados do profissional
    res.status(200).json({
      message: 'Login efetuado com sucesso!',
      profissional
    });

  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno no servidor ao tentar realizar o login.' });
  }
});








// Inicia o servidor na porta 5000
app.listen(5000, () => {
  console.log('🚀 Servidor rodando na porta 5000');
});