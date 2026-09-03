const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
async function callGroq(system, user, maxTokens = 180, temperature = 0.6) {
    if (!GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY não configurada. Defina no arquivo .env');
    }
    const body = {
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', // Tenta ler do .env, senão usa o padrão
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
    };
    const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq API error ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    return data.choices[0].message.content.trim();
}
export async function gerarRespostaReview(nomeCliente, rating, comment, nomeEmpresa, exemplosEstilo) {
    const local = nomeEmpresa ? ` do estabelecimento "${nomeEmpresa}"` : '';
    let system = 'Você responde avaliações negativas de clientes de forma empática, profissional e breve (máximo 3 frases). Peça desculpas quando apropriado e indique que a equipe vai analisar. Não invente políticas ou promessas específicas.';
    if (exemplosEstilo && exemplosEstilo.trim().length > 20) {
        system += `\n\nImite o estilo de escrita do dono do negócio com base nestes exemplos de respostas anteriores dele:\n---\n${exemplosEstilo.slice(0, 1500)}\n---\nMantenha o mesmo tom, vocabulário e formalidade.`;
    }
    const prompt = `Cliente: ${nomeCliente || 'Anônimo'}
Nota: ${rating}/5
Comentário: ${comment}

Escreva uma resposta curta para esta avaliação negativa${local}.`;
    return callGroq(system, prompt);
}
export async function gerarTagsSemanticas(rating, comment) {
    if (!comment || comment.trim().length < 3) {
        if (rating >= 4)
            return ['#ExperienciaPositiva'];
        if (rating <= 2)
            return ['#ExperienciaNegativa'];
        return ['#Neutro'];
    }
    const system = `Você analisa avaliações de estabelecimentos comerciais.
Retorne APENAS um JSON array de 1 a 5 tags em português no formato hashtag CamelCase, sem espaços.
Exemplos válidos: ["#AtendimentoRuim","#ComidaExcelente","#PrecoAlto","#AmbienteAgradavel"]
Não explique. Não use markdown. Apenas o array JSON.`;
    const user = `Nota: ${rating}/5
Comentário: ${comment}`;
    const raw = await callGroq(system, user, 120, 0.3);
    try {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map((t) => String(t).trim())
            .filter((t) => t.startsWith('#') && t.length > 2 && t.length < 40)
            .slice(0, 5);
    }
    catch {
        const matches = raw.match(/#[\wÀ-ú]+/g);
        return matches ? matches.slice(0, 5) : [];
    }
}
